## About this test suite

These tests came from [kangax compat table](https://github.com/kangax/compat-table) which tests for specific ES features.

In our case, we only need to test parsing and not actually execute the tests.

## Updating

You can run the following script from this directory to update this test suite.

```sh
curl -L -o data-common.json https://raw.githubusercontent.com/kangax/compat-table/gh-pages/data-common.json
curl -L -o data-es5.js https://raw.githubusercontent.com/kangax/compat-table/gh-pages/data-es5.js
curl -L -o data-es6.js https://raw.githubusercontent.com/kangax/compat-table/gh-pages/data-es6.js
curl -L -o data-es2016plus.js https://raw.githubusercontent.com/kangax/compat-table/gh-pages/data-es2016plus.js
curl -L -o data-esintl.js https://raw.githubusercontent.com/kangax/compat-table/gh-pages/data-esintl.js
curl -L -o data-esnext.js https://raw.githubusercontent.com/kangax/compat-table/gh-pages/data-esnext.js
```