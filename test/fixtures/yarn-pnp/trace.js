const { nodeFileTrace } = require('@vercel/nft');
const { join, sep, extname } = require('path');

Promise.all(
  process.argv.slice(2).map((filename) => {
    return nodeFileTrace([join(__dirname, filename)]).then(({ fileList }) => ({
      entrypoint: filename,
      fileList: fileList.sort().map((pathname) => {
        return pathname
          .split(sep)
          .map((part) => {
            return extname(part) === '.zip'
              ? part.split(/\-/).slice(0, -2).join('-').concat('.zip')
              : part;
          })
          .join(sep);
      }),
    }));
  })
).then((res) => console.log(JSON.stringify(res)));
