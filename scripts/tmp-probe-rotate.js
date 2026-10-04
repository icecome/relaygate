'use strict';
// 临时探针：验证 startClient() 的编码假说与 /IT 任务会话落点，跑完即删
const { execSync } = require('child_process');

// 1) Node execSync 捕获 schtasks 输出（startClient 的真实路径）
let out = '';
try {
  out = execSync('schtasks /create /tn __rg_probe_enc /tr "cmd /c exit" /sc once /st 00:00 /f', { encoding: 'utf8', timeout: 15000 }).trim();
} catch (e) {
  out = 'THREW status=' + e.status + ' stdout=' + String(e.stdout || '').trim();
}
console.log('NODE_OUT >>>' + out + '<<<');
console.log('INCLUDES_SUCCESS =', out.includes('SUCCESS'));
try { execSync('schtasks /delete /tn __rg_probe_enc /f'); } catch {}

// 2) schtasks /IT 任务实际落在哪个会话
const fs = require('fs');
const sess = process.env.TEMP + '\\rg_probe_sess.txt';
try { fs.unlinkSync(sess); } catch {}
try {
  execSync('schtasks /create /tn __rg_probe_it /tr "powershell -NoProfile -Command \\"(Get-Process -Id $PID).SessionId | Out-File -Encoding ascii ' + sess + '\\"" /sc once /st 00:00 /IT /f', { timeout: 15000 });
  execSync('schtasks /run /tn __rg_probe_it', { timeout: 15000 });
} catch (e) { console.log('IT task err:', e.message); }
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
if (fs.existsSync(sess)) {
  console.log('IT_TASK_SESSION_ID =', fs.readFileSync(sess, 'utf8').trim(), '(my session =', process.pid ? require('child_process').execSync('powershell -NoProfile -Command "(Get-Process -Id $PID).SessionId"', { encoding: 'utf8' }).trim() : '?', ')');
  try { fs.unlinkSync(sess); } catch {}
} else {
  console.log('IT_TASK_SESSION_ID = <no output>');
}
try { execSync('schtasks /delete /tn __rg_probe_it /f'); } catch {}
