const Queue = require('bull');
const connection = process.env.BULL_REDIS_CONNECTION; // Create free tier from https://redislabs.com
const pdfQueue = new Queue('pdf transcoding', connection);

pdfQueue.process(function(job, done) {
  job.progress(42);
  job.progress(99);
  done();
  pdfQueue.close();
});

pdfQueue.add({ pdf: 'http://example.com/file.pdf' });