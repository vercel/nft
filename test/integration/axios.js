const axios = require("axios");

(async () => {
  const { data } = await axios({
    url: "https://example.vercel.sh"
  });
  if (data.status !== "success") {
    throw new Error("Unexpected response: " + JSON.stringify(data));
  }  
})();
