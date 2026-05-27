const DB = 'https://favor-board-default-rtdb.europe-west1.firebasedatabase.app';
const TG_TOKEN = '7903746612:AAE2XbGDLt0tLERXf1IiGaA9OLOJytU4BsE';
const TG_CHAT = '-5063208066';

let seenTasks = new Set();
let seenComments = new Set();
let initialized = false;
let lastUpdateId = 0;
let userMap = {}; // { slot_key: telegramUserId }
let slots = {};   // { slot_key: { username, passwordHash } }

// ── Firebase helpers
async function fbGet(path) {
  try { const r = await fetch(DB + '/' + path + '.json'); return r.ok ? r.json() : null; } catch { return null; }
}
async function fbPatch(path, data) {
  try { await fetch(DB + '/' + path + '.json', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); } catch {}
}
async function fbDelete(path) {
  try { await fetch(DB + '/' + path + '.json', { method: 'DELETE' }); } catch {}
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

// ── Notify: send to all registered users except author's slot
async function notify(text, authorSlot) {
  const registeredCount = Object.keys(userMap).length;
  if (registeredCount > 0) {
    const authorTgId = authorSlot ? userMap[authorSlot] : null;
    const sentToIds = new Set(); // prevent duplicate sends to same Telegram ID
    let sent = 0;
    for (const slotKey in userMap) {
      const tgId = userMap[slotKey];
      if (authorSlot && tgId === authorTgId) { console.log('Skip author slot:', slotKey); continue; }
      if (sentToIds.has(tgId)) { console.log('Skip duplicate TG ID:', tgId); continue; }
      sentToIds.add(tgId);
      await sendPrivate(tgId, text);
      sent++;
    }
    if (sent > 0) return;
  }
  await sendGroup(text);
}

// ── Notify specific slot
async function notifySlot(slotKey, text) {
  const tgId = userMap[slotKey];
  if (tgId) { await sendPrivate(tgId, text); return; }
  // fallback to group if not registered
  const s = slots[slotKey];
  const name = s ? s.username : slotKey;
  await sendGroup(name + ': ' + text);
}

// ── Load state from Firebase
async function loadState() {
  const seen = await fbGet('bot_seen');
  if (seen) {
    if (seen.tasks) seen.tasks.forEach(id => seenTasks.add(id));
    if (seen.comments) seen.comments.forEach(id => seenComments.add(id));
    if (seen.lastUpdateId) lastUpdateId = seen.lastUpdateId;
  }
  const map = await fbGet('bot_usermap');
  if (map) userMap = map;
  const sl = await fbGet('user_slots');
  if (sl) slots = sl;
  console.log('State loaded: ' + seenTasks.size + ' tasks, ' + seenComments.size + ' comments, ' + Object.keys(userMap).length + ' registered users');
}

async function saveState() {
  await fbPatch('bot_seen', {
    tasks: Array.from(seenTasks).slice(-1000),
    comments: Array.from(seenComments).slice(-1000),
    lastUpdateId
  });
}

// ── Poll Telegram for registrations
async function pollTelegram() {
  const d = await tgGet('getUpdates', { offset: lastUpdateId + 1, limit: 100, timeout: 0 });
  if (!d || !d.ok || !d.result || !d.result.length) return;
  let changed = false;
  for (const update of d.result) {
    lastUpdateId = update.update_id;
    const msg = update.message;
    if (!msg || !msg.text || !msg.from || msg.from.is_bot) continue;
    const text = msg.text.trim();
    const fromId = msg.from.id;
    // Find matching slot by username
    for (const slotKey in slots) {
      const slot = slots[slotKey];
      if (slot && slot.username && slot.username.toLowerCase() === text.toLowerCase()) {
        userMap[slotKey] = fromId;
        changed = true;
        console.log('Registered: ' + slot.username + ' (' + slotKey + ') = TG ' + fromId);
        await sendPrivate(fromId, 'You are registered as ' + slot.username + '. You will get Dugnad notifications here!');
        break;
      }
    }
  }
  if (changed) await fbPatch('bot_usermap', userMap);
}

// ── Find slot key for a username (author of task/comment)
function findSlotByUsername(username) {
  for (const slotKey in slots) {
    if (slots[slotKey] && slots[slotKey].username === username) return slotKey;
  }
  return null;
}

// ── Find slot key for task owner
function findOwnerSlot(task) {
  return findSlotByUsername(task.author);
}

// ── Check all tasks and comments
async function checkFavorBoard() {
  // Reload slots in case new users registered
  const sl = await fbGet('user_slots');
  if (sl) slots = sl;

  const raw = await fbGet('tasks');
  if (!raw || typeof raw !== 'object') return;
  const tasks = Object.entries(raw).map(([id, v]) => ({ id, ...v }));
  let changed = false;

  for (const task of tasks) {
    // ── New task notification
    if (!seenTasks.has(task.id)) {
      if (initialized) {
        const msg = '🤝 New favor from ' + task.author + '\n' + task.title +
          (task.desc ? '\n' + task.desc : '') +
          (task.deadline ? '\nDeadline: ' + new Date(task.deadline).toLocaleString() : '') +
          '\n\nOpen Dugnad to help!';
        const authorSlot = findSlotByUsername(task.author);
        await notify(msg, authorSlot);
      }
      seenTasks.add(task.id);
      changed = true;
    }

    // ── New accept notifications to owner
    if (task.acceptedBy && initialized) {
      for (const slotKey in task.acceptedBy) {
        const entry = task.acceptedBy[slotKey];
        if (!entry || entry.ownerNotified) continue;
        const acceptorName = entry.acceptorName || slotKey;
        const bw = entry.byWhen ? ' ' + formatByWhen(entry.byWhen) : '';
        const msg = '✋ ' + acceptorName + ' accepted your favor "' + task.title + '"' + bw + '\n\nOpen Dugnad to follow up.';
        const ownerSlot = findOwnerSlot(task);
        if (ownerSlot) {
          await notifySlot(ownerSlot, msg);
          // Mark as notified
          const updatedAb = Object.assign({}, task.acceptedBy);
          updatedAb[slotKey] = Object.assign({}, entry, { ownerNotified: true });
          await fbPatch('tasks/' + task.id, { acceptedBy: updatedAb });
          task.acceptedBy = updatedAb;
          changed = true;
        }
      }
    }

    // ── New comments
    const cr = await fbGet('comments/' + task.id);
    if (cr && typeof cr === 'object') {
      const comments = Object.entries(cr).map(([id, v]) => ({ id, ...v }));
      for (const c of comments) {
        if (!seenComments.has(c.id)) {
          if (initialized) {
            const msg = '💬 ' + c.author + ' replied on "' + task.title + '"' +
              (c.text ? '\n' + c.text : '\n[photo]') +
              '\n\nOpen Dugnad!';
            const authorSlot = findSlotByUsername(c.author);
            await notify(msg, authorSlot);
          }
          seenComments.add(c.id);
          changed = true;
        }
      }
    }

    // ── Smart reminders for accepted tasks
    if (task.acceptedBy && task.status !== 'done') {
      for (const slotKey in task.acceptedBy) {
        const entry = task.acceptedBy[slotKey];
        if (!entry || !entry.reminders || !entry.reminders.length) continue;
        if (entry.reminderType === 'off') continue;

        const remindersSet = entry.remindersSet || [];
        let reminderChanged = false;

        for (const reminderTime of entry.reminders) {
          const reminderId = task.id + '_' + slotKey + '_' + reminderTime;
          if (remindersSet.includes(reminderTime)) continue; // already sent
          if (Date.now() < reminderTime) continue; // not yet
          if (Date.now() > reminderTime + 3600000) { // more than 1 hour late - skip
            remindersSet.push(reminderTime);
            reminderChanged = true;
            continue;
          }
          // Send reminder to acceptor
          const name = entry.acceptorName || slotKey;
          const msg = '⏰ Reminder: You accepted to do "' + task.title + '" ' + formatByWhen(entry.byWhen) + '\n\nOpen Dugnad to mark it done!';
          await notifySlot(slotKey, msg);
          remindersSet.push(reminderTime);
          reminderChanged = true;
          console.log('Sent reminder to ' + name + ' for task ' + task.title);
        }

        if (reminderChanged) {
          const updatedAb = Object.assign({}, task.acceptedBy);
          updatedAb[slotKey] = Object.assign({}, entry, { remindersSet });
          await fbPatch('tasks/' + task.id, { acceptedBy: updatedAb });
        }
      }
    }

    // ── Overdue notification to owner (not acceptor)
    if (task.status !== 'done' && task.acceptedBy) {
      for (const slotKey in task.acceptedBy) {
        const entry = task.acceptedBy[slotKey];
        if (!entry || !entry.byWhen) continue;
        if (Date.now() < entry.byWhen) continue; // not overdue yet
        if (entry.overdueNotified) continue; // already notified owner

        // Notify owner only
        const ownerSlot = findOwnerSlot(task);
        const acceptorName = entry.acceptorName || slotKey;
        const msg = '⚠️ ' + acceptorName + ' accepted your favor "' + task.title + '" but hasn\'t marked it done yet.\n\nOpen Dugnad to follow up.';
        if (ownerSlot) {
          await notifySlot(ownerSlot, msg);
        } else {
          await sendGroup(msg);
        }

        // Mark as overdue-notified
        const updatedAb = Object.assign({}, task.acceptedBy);
        updatedAb[slotKey] = Object.assign({}, entry, { overdueNotified: true });
        await fbPatch('tasks/' + task.id, { acceptedBy: updatedAb });
        console.log('Notified owner about overdue: ' + task.title);
      }
    }
  }

  if (changed) await saveState();
  if (!initialized) {
    initialized = true;
    console.log('Bot ready! Watching ' + seenTasks.size + ' tasks');
  }
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

async function main() {
  console.log('Dugnad bot starting...');
  await loadState();
  await checkFavorBoard();
  setInterval(pollTelegram, 5000);
  setInterval(checkFavorBoard, 10000); // check every 10s for reminders
  setInterval(async () => { const sl = await fbGet('user_slots'); if (sl) slots = sl; }, 60000);
}

main();
