const chrome = require('chrome-aws-lambda');
const { launch } = require('puppeteer-core');
const lighthouse = require('lighthouse');
const { URL } = require('url');

async function getOptions() {
  const options = {
    args: chrome.args,
    executablePath: await chrome.executablePath,
    headless: chrome.headless,
  };
  return options;
}

async function getResult(url) {
  const options = await getOptions();
  const browser = await launch(options);
  const { port } = new URL(browser.wsEndpoint());
  const result = await lighthouse(url, {
    port,
    output: 'html',
    logLevel: 'error',
  });
  await browser.close();
  return result;
}

async function main() {
  const result = await getResult('https://zeit.co/about');
  if (req && result && result.lhr && result.lhr.categories) {
    console.log('success');
  } else {
    console.log('fail');
  }
}

getResult('https://zeit.co/about')
  .then(result => {
    if (result && result.lhr && result.lhr.categories) {
      console.log('success');
    } else {
      throw new Error('failed to get result')
    }
  })
  .catch(err => {
    console.error(err)
  });