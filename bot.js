const DB = 'https://favor-board-default-rtdb.europe-west1.firebasedatabase.app';
const TG_TOKEN = '7903746612:AAE2XbGDLt0tLERXf1IiGaA9OLOJytU4BsE';
const TG_CHAT = '-5063208066';

const ALLOWED_WORKSPACES = ['arild', 'test1', 'test2']; // keep in sync with app

let initialized = false;
let lastUpdateId = 0;
// Per-workspace state: { ws: { seenTasks:Set, seenComments:Set, slots:{} } }
let wsState = {};
// Global telegram registration: { tgId: { workspace, slotKey } }
let botUsers = {}; // { tgId: {workspace, slotKey} }

// ── Firebase helpers
async function fbGet(path) {
  try { const r = await fetch(DB + '/' + path + '.json'); return r.ok ? r.json() : null; } catch { return null; }
}
async function fbPatch(path, data) {
  try { await fetch(DB + '/' + path + '.json', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); } catch {}
}

// ── Telegram helpers
async function tgPost(method, data) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    return r.ok ? r.json() : null;
  } catch { return null; }
}
async function tgGet(method, params) {
  try {
    const qs = Object.entries(params || {}).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/' + method + (qs ? '?' + qs : ''));
    return r.ok ? r.json() : null;
  } catch { return null; }
}
async function sendPrivate(tgId, text) {
  const d = await tgPost('sendMessage', { chat_id: tgId, text });
  if (!d || !d.ok) console.error('Private send failed to ' + tgId + ':', d && d.description);
}
async function sendGroup(text) {
  await tgPost('sendMessage', { chat_id: TG_CHAT, text });
}

// ── Get telegram IDs registered in a given workspace, as { slotKey: tgId }
function workspaceUserMap(ws) {
  const map = {};
  for (const tgId in botUsers) {
    if (botUsers[tgId].workspace === ws) map[botUsers[tgId].slotKey] = tgId;
  }
  return map;
}

// ── Notify all registered users in a workspace except author
async function notify(ws, text, authorSlot) {
  const userMap = workspaceUserMap(ws);
  const slotKeys = Object.keys(userMap);
  if (slotKeys.length > 0) {
    const authorTgId = authorSlot ? userMap[authorSlot] : null;
    const sentToIds = new Set();
    let sent = 0;
    for (const slotKey of slotKeys) {
      const tgId = userMap[slotKey];
      if (authorSlot && tgId === authorTgId) continue;
      if (sentToIds.has(tgId)) continue;
      sentToIds.add(tgId);
      await sendPrivate(tgId, text);
      sent++;
    }
    if (sent > 0) return;
  }
  await sendGroup(text);
}

// ── Notify a specific slot in a workspace
async function notifySlot(ws, slotKey, text) {
  const userMap = workspaceUserMap(ws);
  const tgId = userMap[slotKey];
  if (tgId) { await sendPrivate(tgId, text); return; }
  const slots = wsState[ws] ? wsState[ws].slots : {};
  const s = slots[slotKey];
  const name = s ? s.username : slotKey;
  await sendGroup(name + ': ' + text);
}

function findSlotByUsername(ws, username) {
  const slots = wsState[ws] ? wsState[ws].slots : {};
  for (const slotKey in slots) {
    if (slots[slotKey] && slots[slotKey].username === username) return slotKey;
  }
  return null;
}

// ── Load saved state
async function loadState() {
  const saved = await fbGet('bot_state');
  if (saved) {
    if (saved.lastUpdateId) lastUpdateId = saved.lastUpdateId;
    if (saved.workspaces) {
      for (const ws in saved.workspaces) {
        wsState[ws] = {
          seenTasks: new Set(saved.workspaces[ws].tasks || []),
          seenComments: new Set(saved.workspaces[ws].comments || []),
          slots: {}
        };
      }
    }
  }
  const users = await fbGet('bot_users');
  if (users) botUsers = users;
  // Ensure all allowed workspaces have state
  for (const ws of ALLOWED_WORKSPACES) {
    if (!wsState[ws]) wsState[ws] = { seenTasks: new Set(), seenComments: new Set(), slots: {} };
  }
  console.log('State loaded. Workspaces: ' + ALLOWED_WORKSPACES.join(', ') + '. Registered users: ' + Object.keys(botUsers).length);
}

async function saveState() {
  const workspaces = {};
  for (const ws in wsState) {
    workspaces[ws] = {
      tasks: Array.from(wsState[ws].seenTasks).slice(-1000),
      comments: Array.from(wsState[ws].seenComments).slice(-1000)
    };
  }
  await fbPatch('bot_state', { lastUpdateId, workspaces });
}

// ── Poll Telegram for registrations (format: "workspace:username" or just "username")
async function pollTelegram() {
  const d = await tgGet('getUpdates', { offset: lastUpdateId + 1, limit: 100, timeout: 0 });
  if (!d || !d.ok || !d.result || !d.result.length) return;
  let changed = false;
  for (const update of d.result) {
    lastUpdateId = update.update_id;
    const msg = update.message;
    if (!msg || !msg.text || !msg.from || msg.from.is_bot) continue;
    const text = msg.text.trim();
    const fromId = String(msg.from.id);

    // Parse "workspace:username" format
    let ws = null, username = null;
    if (text.includes(':')) {
      const parts = text.split(':');
      ws = parts[0].trim().toLowerCase();
      username = parts.slice(1).join(':').trim();
    } else {
      username = text;
    }

    // If workspace specified, try to register in it
    if (ws && ALLOWED_WORKSPACES.includes(ws)) {
      const slots = await fbGet('workspaces/' + ws + '/user_slots');
      if (slots) {
        let matched = false;
        for (const slotKey in slots) {
          if (slots[slotKey] && slots[slotKey].username && slots[slotKey].username.toLowerCase() === username.toLowerCase()) {
            botUsers[fromId] = { workspace: ws, slotKey };
            changed = true;
            matched = true;
            await sendPrivate(fromId, 'You are registered as ' + slots[slotKey].username + ' in workspace "' + ws + '". You will get Dugnad notifications here!');
            console.log('Registered TG ' + fromId + ' as ' + username + ' in ' + ws);
            break;
          }
        }
        if (!matched) {
          await sendPrivate(fromId, 'Could not find "' + username + '" in workspace "' + ws + '". Make sure you registered in the app first, then send: ' + ws + ':YourName');
        }
      } else {
        await sendPrivate(fromId, 'Workspace "' + ws + '" has no users yet. Register in the app first.');
      }
    } else if (ws) {
      await sendPrivate(fromId, 'Unknown workspace "' + ws + '". Please check the code with your admin.');
    } else {
      // No workspace specified - search all workspaces for the username
      let found = false;
      for (const w of ALLOWED_WORKSPACES) {
        const slots = await fbGet('workspaces/' + w + '/user_slots');
        if (!slots) continue;
        for (const slotKey in slots) {
          if (slots[slotKey] && slots[slotKey].username && slots[slotKey].username.toLowerCase() === username.toLowerCase()) {
            botUsers[fromId] = { workspace: w, slotKey };
            changed = true; found = true;
            await sendPrivate(fromId, 'You are registered as ' + slots[slotKey].username + ' in workspace "' + w + '". You will get Dugnad notifications here!');
            console.log('Registered TG ' + fromId + ' as ' + username + ' in ' + w + ' (auto-detected)');
            break;
          }
        }
        if (found) break;
      }
      if (!found) {
        await sendPrivate(fromId, 'Could not find "' + username + '". Please send your workspace and name like this: arild:YourName');
      }
    }
  }
  if (changed) await fbPatch('bot_users', botUsers);
}

function formatByWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const tom = new Date(now); tom.setDate(tom.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return 'by end of today';
  if (d.toDateString() === tom.toDateString()) return 'by end of tomorrow';
  return 'by ' + d.toLocaleDateString();
}

// ── Check one workspace
async function checkWorkspace(ws) {
  const state = wsState[ws];
  if (!state) return;

  // Reload slots
  const sl = await fbGet('workspaces/' + ws + '/user_slots');
  if (sl) state.slots = sl;

  const raw = await fbGet('workspaces/' + ws + '/tasks');
  if (!raw || typeof raw !== 'object') return;
  const tasks = Object.entries(raw).map(([id, v]) => ({ id, ...v }));

  for (const task of tasks) {
    // New task
    if (!state.seenTasks.has(task.id)) {
      if (initialized) {
        const msg = '🤝 New favor from ' + task.author + '\n' + task.title +
          (task.desc ? '\n' + task.desc : '') +
          (task.deadline ? '\nDeadline: ' + new Date(task.deadline).toLocaleString() : '') +
          '\n\nOpen Dugnad to help!';
        await notify(ws, msg, findSlotByUsername(ws, task.author));
      }
      state.seenTasks.add(task.id);
    }

    // New accept → notify owner
    if (task.acceptedBy && initialized) {
      for (const slotKey in task.acceptedBy) {
        const entry = task.acceptedBy[slotKey];
        if (!entry || entry.ownerNotified) continue;
        const acceptorName = entry.acceptorName || slotKey;
        const bw = entry.byWhen ? ' ' + formatByWhen(entry.byWhen) : '';
        const ownerSlot = findSlotByUsername(ws, task.author);
        if (ownerSlot) {
          await notifySlot(ws, ownerSlot, '✋ ' + acceptorName + ' accepted your favor "' + task.title + '"' + bw + '\n\nOpen Dugnad to follow up.');
          const updatedAb = Object.assign({}, task.acceptedBy);
          updatedAb[slotKey] = Object.assign({}, entry, { ownerNotified: true });
          await fbPatch('workspaces/' + ws + '/tasks/' + task.id, { acceptedBy: updatedAb });
          task.acceptedBy = updatedAb;
        }
      }
    }

    // New comments
    const cr = await fbGet('workspaces/' + ws + '/comments/' + task.id);
    if (cr && typeof cr === 'object') {
      const comments = Object.entries(cr).map(([id, v]) => ({ id, ...v }));
      for (const c of comments) {
        if (!state.seenComments.has(c.id)) {
          if (initialized) {
            const msg = '💬 ' + c.author + ' replied on "' + task.title + '"' +
              (c.text ? '\n' + c.text : '\n[photo]') + '\n\nOpen Dugnad!';
            await notify(ws, msg, findSlotByUsername(ws, c.author));
          }
          state.seenComments.add(c.id);
        }
      }
    }

    // Smart reminders for acceptors
    if (task.acceptedBy && task.status !== 'done') {
      for (const slotKey in task.acceptedBy) {
        const entry = task.acceptedBy[slotKey];
        if (!entry || !entry.reminders || !entry.reminders.length) continue;
        if (entry.reminderType === 'off') continue;
        const remindersSet = entry.remindersSet || [];
        let reminderChanged = false;
        for (const reminderTime of entry.reminders) {
          if (remindersSet.includes(reminderTime)) continue;
          if (Date.now() < reminderTime) continue;
          if (Date.now() > reminderTime + 3600000) { remindersSet.push(reminderTime); reminderChanged = true; continue; }
          const msg = '⏰ Reminder: You accepted to do "' + task.title + '" ' + formatByWhen(entry.byWhen) + '\n\nOpen Dugnad to mark it done!';
          await notifySlot(ws, slotKey, msg);
          remindersSet.push(reminderTime);
          reminderChanged = true;
        }
        if (reminderChanged) {
          const updatedAb = Object.assign({}, task.acceptedBy);
          updatedAb[slotKey] = Object.assign({}, entry, { remindersSet });
          await fbPatch('workspaces/' + ws + '/tasks/' + task.id, { acceptedBy: updatedAb });
        }
      }
    }

    // Overdue → notify owner only
    if (task.status !== 'done' && task.acceptedBy) {
      for (const slotKey in task.acceptedBy) {
        const entry = task.acceptedBy[slotKey];
        if (!entry || !entry.byWhen) continue;
        if (Date.now() < entry.byWhen) continue;
        if (entry.overdueNotified) continue;
        const ownerSlot = findSlotByUsername(ws, task.author);
        const acceptorName = entry.acceptorName || slotKey;
        const msg = '⚠️ ' + acceptorName + ' accepted your favor "' + task.title + '" but hasn\'t marked it done yet.\n\nOpen Dugnad to follow up.';
        if (ownerSlot) await notifySlot(ws, ownerSlot, msg);
        else await sendGroup(msg);
        const updatedAb = Object.assign({}, task.acceptedBy);
        updatedAb[slotKey] = Object.assign({}, entry, { overdueNotified: true });
        await fbPatch('workspaces/' + ws + '/tasks/' + task.id, { acceptedBy: updatedAb });
      }
    }
  }
}

async function checkAll() {
  for (const ws of ALLOWED_WORKSPACES) {
    await checkWorkspace(ws);
  }
  await saveState();
  if (!initialized) { initialized = true; console.log('Bot ready! Watching ' + ALLOWED_WORKSPACES.length + ' workspaces'); }
}

async function main() {
  console.log('Dugnad multi-workspace bot starting...');
  await loadState();
  await checkAll();
  setInterval(pollTelegram, 5000);
  setInterval(checkAll, 10000);
}

main();
