export default {
  async fetch(request, env) {
    const rssUrl = "https://keep.md/api/x-rss/knshowcom.xml?content=posts";

    const response = await fetch(rssUrl);
    const rss = await response.text();

    return new Response(rss, {
      headers: {
        "Content-Type": "application/xml; charset=UTF-8"
      }
    });
  }
};
