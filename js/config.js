// Where the hosted Gemini API lives (server/ in this repo, deployed to Google Cloud Run).
// When the page is opened from localhost, it talks to a local copy of the server instead.

const LOCAL = ["localhost", "127.0.0.1"].includes(globalThis.location?.hostname);

export const HOSTED_API = LOCAL ? "http://localhost:8080" : "https://starcrew-api-770118043979.us-east1.run.app";
