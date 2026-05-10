const DB = 'https://favor-board-default-rtdb.europe-west1.firebasedatabase.app';
const TG_TOKEN = '7903746612:AAE2XbGDLt0tLERXf1IiGaA9OLOJytU4BsE';
const TG_CHAT = '-5063208066';

let seenTasks = new Set();
let seenComments = new Set();
let initialized = false;

async function fbGet(path) {
  try {
    const r = await fetch(DB + '/' + path + '.json');
    return r.ok ? r.json() : null;
  } catch(e) { return null; }
}

async function fbPatch(path, data) {
  try {
    await fetch(DB + '/' + path + '.json', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch(e) {}
}

async function tgSend(text) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: text })
    });
    const d = await r.json();
    if(d.ok) console.log('Sent: ' + text.substring(0, 80));
    else console.error('TG error:', d.description);
  } catch(e) { console.error('TG fetch error:', e.message); }
}

async function loadSeenFromFirebase() {
  const raw = await fbGet('bot_seen');
  if(raw) {
    if(raw.tasks) raw.tasks.forEach(function(id) { seenTasks.add(id); });
    if(raw.comments) raw.comments.forEach(function(id) { seenComments.add(id); });
  }
  console.log('Loaded seen: ' + seenTasks.size + ' tasks, ' + seenComments.size + ' comments');
}

async function saveSeenToFirebase() {
  await fbPatch('bot_seen', {
    tasks: Array.from(seenTasks).slice(-1000),
    comments: Array.from(seenComments).slice(-1000)
  });
}

async function checkAll() {
  const raw = await fbGet('tasks');
  if(!raw || typeof raw !== 'object') return;

  const tasks = Object.entries(raw).map(function(e) {
    return Object.assign({ id: e[0] }, e[1]);
  });

  let changed = false;

  for(var i = 0; i < tasks.length; i++) {
    var task = tasks[i];

    if(!seenTasks.has(task.id)) {
      if(initialized) {
        var msg = 'New favor from ' + task.author + '\n' + task.title;
        if(task.desc) msg += '\n' + task.desc;
        if(task.deadline) msg += '\nDeadline: ' + new Date(task.deadline).toLocaleString();
        msg += '\n\nOpen FavorBoard to help!';
        await tgSend(msg);
      }
      seenTasks.add(task.id);
      changed = true;
    }

    var commentsRaw = await fbGet('comments/' + task.id);
    if(commentsRaw && typeof commentsRaw === 'object') {
      var comments = Object.entries(commentsRaw).map(function(e) {
        return Object.assign({ id: e[0] }, e[1]);
      });
      for(var j = 0; j < comments.length; j++) {
        var comment = comments[j];
        if(!seenComments.has(comment.id)) {
          if(initialized) {
            var cmsg = comment.author + ' replied on "' + task.title + '"';
            if(comment.text) cmsg += '\n' + comment.text;
            if(comment.imageUrl) cmsg += '\n[photo attached]';
            cmsg += '\n\nOpen FavorBoard to respond!';
            await tgSend(cmsg);
          }
          seenComments.add(comment.id);
          changed = true;
        }
      }
    }
  }

  if(changed) await saveSeenToFirebase();
  if(!initialized) {
    initialized = true;
    console.log('Bot ready! Watching ' + seenTasks.size + ' tasks, ' + seenComments.size + ' comments');
  }
}

async function main() {
  console.log('FavorBoard bot starting...');
  await loadSeenFromFirebase();
  await checkAll();
  setInterval(checkAll, 5000);
}

main();
