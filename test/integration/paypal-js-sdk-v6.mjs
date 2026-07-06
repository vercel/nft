// Regression test for https://github.com/vercel/nft/issues/599
// @paypal/paypal-js@10.0.1 exposes ./sdk-v6 with only "types" + "import"
// conditions. Tracing must include dist/v6/esm/paypal-js.js so the named
// export loadCoreSdkScript resolves at runtime after packaging.
import { loadCoreSdkScript } from '@paypal/paypal-js/sdk-v6';

if (typeof loadCoreSdkScript !== 'function') {
  throw new Error(
    `Expected loadCoreSdkScript to be a function, got ${typeof loadCoreSdkScript}`,
  );
}
