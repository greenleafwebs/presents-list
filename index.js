export default {
  async fetch(request, env) {
    const rssUrl =
      "https://keep.md/api/x-rss/knshowcom.xml?content=posts";

    // RSSを取得
    const response = await fetch(rssUrl);

    if (!response.ok) {
      return new Response("RSS取得失敗", { status: 500 });
    }

    const rss = await response.text();

    // D1からキーワードを取得
    const { results: keywords } = await env.DB
      .prepare("SELECT keyword FROM keywords")
      .all();

    // RSSの記事を抽出
    const items = rss.match(/<item>[\s\S]*?<\/item>/g) || [];

    let savedCount = 0;

    for (const item of items) {
      // URL
      const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
      const postUrl = linkMatch
        ? linkMatch[1].trim()
        : null;

      if (!postUrl) continue;

      // タイトル
      const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/);
      const title = titleMatch
        ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()
        : "";

      // 本文
      const descriptionMatch = item.match(
        /<description>([\s\S]*?)<\/description>/
      );

      const description = descriptionMatch
        ? descriptionMatch[1]
            .replace(/<!\[CDATA\[|\]\]>/g, "")
            .trim()
        : "";

      // 検索対象
      const searchText =
        `${title} ${description}`.toLowerCase();

      // キーワードに一致するか確認
      const matched = keywords.some((row) => {
        const keyword = row.keyword.toLowerCase();
        return searchText.includes(keyword);
      });

      if (!matched) continue;

      // 一致した記事を保存
      await env.DB
        .prepare(
          `INSERT OR IGNORE INTO posts (post_url, text)
           VALUES (?, ?)`
        )
        .bind(postUrl, `${title}\n${description}`)
        .run();

      savedCount++;
    }

    return new Response(
      JSON.stringify(
        {
          success: true,
          rssItems: items.length,
          keywords: keywords.map((k) => k.keyword),
          saved: savedCount
        },
        null,
        2
      ),
      {
        headers: {
          "Content-Type": "application/json; charset=UTF-8"
        }
      }
    );
  }
};
