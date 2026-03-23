const { spawn } = require('child_process');
const ssh = spawn('ssh', ['-p', '443', '-o', 'StrictHostKeyChecking=no', '-R0:localhost:3000', 'a.pinggy.io']);
ssh.stdout.on('data', d => console.log('OUT:', d.toString()));
ssh.stderr.on('data', d => console.log('ERR:', d.toString()));
setTimeout(() => { ssh.kill(); process.exit(0); }, 8000);
