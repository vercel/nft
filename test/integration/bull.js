const Queue = require('bull');
// Create free tier on https://redislabs.com and assign redis://:password@hostname:port
const pdfQueue = new Queue('pdf transcoding', process.env.BULL_REDIS_CONNECTION);

pdfQueue.process(function(job, done) {
  job.progress(42);
  done();
  pdfQueue.close();
});

pdfQueue.add({ pdf: 'http://example.com/file.pdf' });
