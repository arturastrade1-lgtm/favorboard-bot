const DB = 'https://favor-board-default-rtdb.europe-west1.firebasedatabase.app';
const TG_TOKEN = '7903746612:AAE2XbGDLt0tLERXf1IiGaA9OLOJytU4BsE';
const TG_CHAT = '-5063208066';

let seenTasks = new Set();
let seenComments = new Set();
let firstRun = true;

async function fbGet(path) {
  const r = await fetch('https://favor-board-default-rtdb.europe-west1.firebasedatabase.app/' + path + '.json');
  return r.ok ? r.json() : null;
}

async function tgSend(text) {
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: text, parse_mode: 'HTML' })
    });
    console.log('Sent: ' + text.substring(0, 60));
  } catch (e) {
    console.error('Telegram error: ' + e.message);
  }
}

async function checkAll() {
  const raw = await fbGet('tasks');
  if (!raw || typeof raw !== 'object') return;

  const tasks = Object.entries(raw).map(function(entry) {
    return Object.assign({ id: entry[0] }, entry[1]);
  });

  for (const task of tasks) {
    if (!seenTasks.has(task.id)) {
      if (!firstRun) {
        const msg = task.desc
          ? 'New favor from ' + task.author + '\n' + task.title + '\n' + task.desc + '\n\nOpen FavorBoard to help!'
          : 'New favor from ' + task.author + '\n' + task.title + '\n\nOpen FavorBoard to help!';
        await tgSend(msg);
      }
      seenTasks.add(task.id);
    }

    const commentsRaw = await fbGet('comments/' + task.id);
    if (commentsRaw && typeof commentsRaw === 'object') {
      const comments = Object.entries(commentsRaw).map(function(entry) {
        return Object.assign({ id: entry[0] }, entry[1]);
      });
      for (const comment of comments) {
        if (!seenComments.has(comment.id)) {
          if (!firstRun) {
            const msg = comment.author + ' replied on "' + task.title + '"\n' + comment.text + '\n\nOpen FavorBoard to respond!';
            await tgSend(msg);
          }
          seenComments.add(comment.id);
        }
      }
    }
  }

  firstRun = false;
}

async function main() {
  console.log('FavorBoard bot started!');
  await checkAll();
  console.log('Ready. Watching for new tasks and comments...');
  setInterval(checkAll, 5000);
}

main();
