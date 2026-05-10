const DB = ‘https://favor-board-default-rtdb.europe-west1.firebasedatabase.app’;
const TG_TOKEN = ‘7903746612:AAE2XbGDLt0tLERXf1IiGaA9OLOJytU4BsE’;
const TG_CHAT = ‘-5063208066’;

let seenTasks = new Set();
let seenComments = new Set();
let firstRun = true;

async function fbGet(path) {
const r = await fetch(`${DB}/${path}.json`);
return r.ok ? r.json() : null;
}

async function tgSend(text) {
try {
await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/json’ },
body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: ‘HTML’ })
});
console.log(‘Telegram sent:’, text.substring(0, 60));
} catch (e) {
console.error(‘Telegram error:’, e.message);
}
}

async function checkTasks() {
const raw = await fbGet(‘tasks’);
if (!raw || typeof raw !== ‘object’) return;

const tasks = Object.entries(raw).map(([id, v]) => ({ id, …v }));

for (const task of tasks) {
if (!seenTasks.has(task.id)) {
if (!firstRun) {
await tgSend(`🤝 <b>New favor from ${task.author}</b>\n${task.title}${task.desc ? '\n' + task.desc : ''}\n\nOpen FavorBoard to help!`);
}
seenTasks.add(task.id);
}

```
// Check comments for this task
const commentsRaw = await fbGet(`comments/${task.id}`);
if (commentsRaw && typeof commentsRaw === 'object') {
  const comments = Object.entries(commentsRaw).map(([id, v]) => ({ id, ...v }));
  for (const comment of comments) {
    if (!seenComments.has(comment.id)) {
      if (!firstRun) {
        await tgSend(`💬 <b>${comment.author}</b> replied on "<b>${task.title}</b>"\n${comment.text}\n\nOpen FavorBoard to respond!`);
      }
      seenComments.add(comment.id);
    }
  }
}
```

}

firstRun = false;
}

async function main() {
console.log(‘FavorBoard bot started!’);
// Initial load - mark everything as seen without notifying
await checkTasks();
console.log(`Loaded ${seenTasks.size} existing tasks, ${seenComments.size} existing comments`);

// Poll every 5 seconds
setInterval(checkTasks, 5000);
}

main();
