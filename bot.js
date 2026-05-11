const DB = 'https://favor-board-default-rtdb.europe-west1.firebasedatabase.app';
const TG_TOKEN = '7903746612:AAE2XbGDLt0tLERXf1IiGaA9OLOJytU4BsE';
const TG_CHAT = '-5063208066';

const USERS = ['User 1','User 2','User 3','User 4','User 5','User 6','User 7','User 8','User 9','User 10'];

let seenTasks = new Set();
let seenComments = new Set();
let initialized = false;
let lastUpdateId = 0;
// Maps FavorBoard username -> Telegram user ID
// e.g. { 'User 1': 123456789 }
let userMap = {};

async function fbGet(path) {
  try { const r = await fetch(DB+'/'+path+'.json'); return r.ok ? r.json() : null; } catch(e) { return null; }
}
async function fbPatch(path, data) {
  try {
    await fetch(DB+'/'+path+'.json', {
      method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)
    });
  } catch(e) {}
}

async function tgGet(method, params) {
  try {
    const qs = Object.entries(params||{}).map(function(e){return e[0]+'='+encodeURIComponent(e[1]);}).join('&');
    const r = await fetch('https://api.telegram.org/bot'+TG_TOKEN+'/'+method+(qs?'?'+qs:''));
    return r.ok ? r.json() : null;
  } catch(e) { return null; }
}

async function tgPost(method, data) {
  try {
    const r = await fetch('https://api.telegram.org/bot'+TG_TOKEN+'/'+method, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)
    });
    return r.ok ? r.json() : null;
  } catch(e) { return null; }
}

async function sendToGroup(text) {
  const d = await tgPost('sendMessage', {chat_id: TG_CHAT, text: text});
  if(d && d.ok) console.log('Group: '+text.substring(0,60));
  else console.error('Group send failed:', d && d.description);
}

async function sendPrivate(tgId, text) {
  const d = await tgPost('sendMessage', {chat_id: tgId, text: text});
  if(!d || !d.ok) console.error('Private send failed to '+tgId+':', d && d.description);
}

async function loadState() {
  // Load seen IDs
  const seen = await fbGet('bot_seen');
  if(seen) {
    if(seen.tasks) seen.tasks.forEach(function(id){seenTasks.add(id);});
    if(seen.comments) seen.comments.forEach(function(id){seenComments.add(id);});
    if(seen.lastUpdateId) lastUpdateId = seen.lastUpdateId;
  }
  // Load user map from Firebase
  const map = await fbGet('bot_usermap');
  if(map) {
    userMap = map;
    console.log('Loaded user map:', JSON.stringify(userMap));
  }
  console.log('Loaded '+seenTasks.size+' seen tasks, '+seenComments.size+' seen comments');
}

async function saveState() {
  await fbPatch('bot_seen', {
    tasks: Array.from(seenTasks).slice(-1000),
    comments: Array.from(seenComments).slice(-1000),
    lastUpdateId: lastUpdateId
  });
}

async function saveUserMap() {
  await fbPatch('bot_usermap', userMap);
}

// Poll Telegram for new messages — handle registration
async function pollTelegram() {
  const d = await tgGet('getUpdates', {offset: lastUpdateId+1, limit: 100, timeout: 0});
  if(!d || !d.ok || !d.result || !d.result.length) return;

  for(var i=0; i<d.result.length; i++) {
    var update = d.result[i];
    lastUpdateId = update.update_id;

    var msg = update.message;
    if(!msg || !msg.text || !msg.from || msg.from.is_bot) continue;

    var text = msg.text.trim();
    var fromId = msg.from.id;
    var fromName = msg.from.first_name || '';

    // Check if message is a valid FavorBoard username
    var matchedUser = null;
    for(var u=0; u<USERS.length; u++) {
      if(text.toLowerCase() === USERS[u].toLowerCase()) {
        matchedUser = USERS[u];
        break;
      }
    }

    if(matchedUser) {
      userMap[matchedUser] = fromId;
      await saveUserMap();
      console.log('Registered: '+matchedUser+' = '+fromId);
      // Reply to confirm
      if(msg.chat.type === 'private') {
        await sendPrivate(fromId, 'You are registered as '+matchedUser+'. You will not receive notifications for your own actions.');
      }
    }
  }
}

async function notify(text, authorUsername) {
  var authorId = userMap[authorUsername];
  var registeredCount = Object.keys(userMap).length;

  if(registeredCount > 0) {
    // Send private to all registered users except the author
    for(var u=0; u<USERS.length; u++) {
      var tgId = userMap[USERS[u]];
      if(!tgId) continue;
      if(tgId === authorId) { console.log('Skipping author: '+authorUsername); continue; }
      await sendPrivate(tgId, text);
    }
    // Never send to group when private messaging is active
    // (group messages can't be hidden from author)
    return;
  }
  // No one registered yet - send to group
  await sendToGroup(text);
}

async function checkFavorBoard() {
  const raw = await fbGet('tasks');
  if(!raw || typeof raw !== 'object') return;

  const tasks = Object.entries(raw).map(function(e){return Object.assign({id:e[0]},e[1]);});
  let changed = false;

  for(var i=0; i<tasks.length; i++) {
    var task = tasks[i];
    if(!seenTasks.has(task.id)) {
      if(initialized) {
        var msg = '🤝 New favor from '+task.author+'\n'+task.title;
        if(task.desc) msg += '\n'+task.desc;
        if(task.deadline) msg += '\nDeadline: '+new Date(task.deadline).toLocaleString();
        msg += '\n\nOpen FavorBoard to help!';
        await notify(msg, task.author);
      }
      seenTasks.add(task.id);
      changed = true;
    }

    var cr = await fbGet('comments/'+task.id);
    if(cr && typeof cr==='object') {
      var comments = Object.entries(cr).map(function(e){return Object.assign({id:e[0]},e[1]);});
      for(var j=0; j<comments.length; j++) {
        var c = comments[j];
        if(!seenComments.has(c.id)) {
          if(initialized) {
            var cm = '💬 '+c.author+' replied on "'+task.title+'"';
            if(c.text) cm += '\n'+c.text;
            if(c.imageUrl) cm += '\n[photo]';
            cm += '\n\nOpen FavorBoard!';
            await notify(cm, c.author);
          }
          seenComments.add(c.id);
          changed = true;
        }
      }
    }
  }

  if(changed) await saveState();
  if(!initialized) {
    initialized = true;
    console.log('Bot ready! '+seenTasks.size+' tasks, '+seenComments.size+' comments watched');
    // Send registration instructions to group once
    var registered = Object.keys(userMap);
    var unregistered = USERS.filter(function(u){return !userMap[u];});
    if(unregistered.length > 0) {
      await sendToGroup(
        'FavorBoard bot is running!\n\n' +
        'To stop receiving your own notifications, message me privately:\n' +
        '1. Open @FavorBoardNotifyBot in Telegram\n' +
        '2. Send your FavorBoard name (e.g. "User 3")\n\n' +
        'Registered: '+(registered.length > 0 ? registered.join(', ') : 'none yet')
      );
    }
  }
}

async function main() {
  console.log('FavorBoard bot starting...');
  await loadState();
  await checkFavorBoard();
  setInterval(pollTelegram, 3000);
  setInterval(checkFavorBoard, 5000);
}

main();
