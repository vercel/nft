const { SerialPort } = require('serialport');

SerialPort.list().catch((err) => {
  if (err?.code !== 'ENOENT') {
    throw err;
  }
});
