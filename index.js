async function run(env) {
  const rssUrl =
    "https://keep.md/api/x-rss/knshowcom.xml?content=posts";

  // RSSを取得
  const response = await fetch(rssUrl);

  if (!response.ok) {
    throw new Error("RSS取得失敗");
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
      ? titleMatch[1]
          .replace(/<!\[CDATA\[|\]\]>/g, "")
          .trim()
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

    // 本文だけを保存
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO posts (post_url, text)
         VALUES (?, ?)`
      )
      .bind(postUrl, description)
      .run();

    savedCount++;
  }

  return {
    success: true,
    rssItems: items.length,
    keywords: keywords.map((k) => k.keyword),
    saved: savedCount
  };
}

export default {
  // 通常アクセス
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      // 保存済み投稿一覧API
      if (url.pathname === "/api/posts") {
        const { results } = await env.DB
          .prepare(
            `SELECT post_url, text
             FROM posts
             ORDER BY rowid DESC
             LIMIT 100`
          )
          .all();

        return new Response(
          JSON.stringify(
            {
              success: true,
              posts: results
            },
            null,
            2
          ),
          {
            headers: {
              "Content-Type": "application/json; charset=UTF-8",
              "Access-Control-Allow-Origin": "*"
            }
          }
        );
      }

      // 手動実行
      const result = await run(env);

      return new Response(
        JSON.stringify(result, null, 2),
        {
          headers: {
            "Content-Type": "application/json; charset=UTF-8"
          }
        }
      );

    } catch (error) {
      return new Response(
        JSON.stringify(
          {
            success: false,
            error: error.message
          },
          null,
          2
        ),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json; charset=UTF-8"
          }
        }
      );
    }
  },

  // Cronで毎日自動実行
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(run(env));
  }
};
