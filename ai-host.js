// Отдельный процесс для нейросети (Electron utilityProcess).
//
// Почему отдельно: библиотека onnxruntime-node выполняет загрузку модели и каждый прогон нейросети
// прямо в потоке JavaScript, а не в фоне. Если делать это в главном процессе программы, окно на это время
// «замерзает». Особенно долго бывает в самый первый раз на новом компьютере: Windows проверяет антивирусом
// свежие библиотеки, драйвер видеокарты собирает свои программы для DirectML — окно получало статус
// «Не отвечает». Здесь вся тяжёлая работа (нейросеть, чтение кадров, расчёт движения камеры) идёт
// в своём процессе, а окно остаётся живым.
//
// Обмен с главным процессом: { id, method, args } -> { id, ok, result | error }; события — { id, event, data }.
const ai = require('./ai');

const port = process.parentPort;
const jobs = new Map(); // id -> token (для отмены слежения)

function send(msg) { try { port.postMessage(msg); } catch (e) {} }

port.on('message', async (e) => {
  const msg = e.data || {};
  const { id, method, args } = msg;
  if (method === 'cancel') {
    jobs.forEach((tok) => { tok.cancelled = true; try { tok.kill && tok.kill(); } catch (err) {} });
    return;
  }
  const ev = (event) => (data) => send({ id, event, data });
  try {
    let result;
    if (method === 'status') result = ai.status(args);
    else if (method === 'prepare') result = await ai.prepare(Object.assign({}, args, { onStage: ev('stage') }));
    else if (method === 'detect') result = await ai.detect(args);
    else if (method === 'segment') result = await require('./seg').segment(args);
    else if (method === 'track') {
      const token = { cancelled: false, kill: null };
      jobs.set(id, token);
      try { result = await ai.track(Object.assign({}, args, { token, onProgress: ev('track') })); }
      finally { jobs.delete(id); }
    } else throw new Error('unknown method ' + method);
    send({ id, ok: true, result });
  } catch (err) {
    send({ id, ok: false, error: (err && err.message) || String(err) });
  }
});

process.on('uncaughtException', (err) => { try { console.error('[ai-host]', err); } catch (e) {} });
send({ ready: true });
