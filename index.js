async function run(env) {
  // 現在はRSSを1件取得
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


// JSONレスポンス
function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Access-Control-Allow-Origin": "*"
      }
    }
  );
}


// リクエストのJSONを取得
async function getJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}


export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      // ==========================================
      // CORS対応
      // ==========================================

      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods":
              "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type"
          }
        });
      }


      // ==========================================
      // 保存済み投稿一覧
      // GET /api/posts
      // ==========================================

      if (
        pathname === "/api/posts" &&
        request.method === "GET"
      ) {
        const { results } = await env.DB
          .prepare(
            `SELECT post_url, text
             FROM posts
             ORDER BY rowid DESC
             LIMIT 100`
          )
          .all();

        return jsonResponse({
          success: true,
          posts: results
        });
      }


      // ==========================================
      // キーワード一覧
      // GET /api/keywords
      // ==========================================

      if (
        pathname === "/api/keywords" &&
        request.method === "GET"
      ) {
        const { results } = await env.DB
          .prepare(
            `SELECT rowid AS id, keyword
             FROM keywords
             ORDER BY rowid ASC`
          )
          .all();

        return jsonResponse({
          success: true,
          keywords: results
        });
      }


      // ==========================================
      // キーワード追加
      // POST /api/keywords
      // ==========================================

      if (
        pathname === "/api/keywords" &&
        request.method === "POST"
      ) {
        const data = await getJson(request);

        if (
          !data ||
          typeof data.keyword !== "string" ||
          !data.keyword.trim()
        ) {
          return jsonResponse(
            {
              success: false,
              error: "キーワードを入力してください"
            },
            400
          );
        }

        const keyword = data.keyword.trim();

        const result = await env.DB
          .prepare(
            `INSERT INTO keywords (keyword)
             VALUES (?)`
          )
          .bind(keyword)
          .run();

        return jsonResponse({
          success: true,
          id: result.meta.last_row_id,
          keyword
        });
      }


      // ==========================================
      // キーワード変更
      // PUT /api/keywords/:id
      // ==========================================

      const keywordMatch =
        pathname.match(/^\/api\/keywords\/(\d+)$/);

      if (
        keywordMatch &&
        request.method === "PUT"
      ) {
        const id = Number(keywordMatch[1]);
        const data = await getJson(request);

        if (
          !data ||
          typeof data.keyword !== "string" ||
          !data.keyword.trim()
        ) {
          return jsonResponse(
            {
              success: false,
              error: "キーワードを入力してください"
            },
            400
          );
        }

        const keyword = data.keyword.trim();

        const result = await env.DB
          .prepare(
            `UPDATE keywords
             SET keyword = ?
             WHERE rowid = ?`
          )
          .bind(keyword, id)
          .run();

        if (!result.meta.changes) {
          return jsonResponse(
            {
              success: false,
              error: "キーワードが見つかりません"
            },
            404
          );
        }

        return jsonResponse({
          success: true,
          id,
          keyword
        });
      }


      // ==========================================
      // キーワード削除
      // DELETE /api/keywords/:id
      // ==========================================

      if (
        keywordMatch &&
        request.method === "DELETE"
      ) {
        const id = Number(keywordMatch[1]);

        const result = await env.DB
          .prepare(
            `DELETE FROM keywords
             WHERE rowid = ?`
          )
          .bind(id)
          .run();

        if (!result.meta.changes) {
          return jsonResponse(
            {
              success: false,
              error: "キーワードが見つかりません"
            },
            404
          );
        }

        return jsonResponse({
          success: true,
          id
        });
      }


      // ==========================================
      // アカウント一覧
      // GET /api/accounts
      // ==========================================

      if (
        pathname === "/api/accounts" &&
        request.method === "GET"
      ) {
        const { results } = await env.DB
          .prepare(
            `SELECT id, username, x_url, rss_url, enabled
             FROM accounts
             ORDER BY id ASC`
          )
          .all();

        return jsonResponse({
          success: true,
          accounts: results
        });
      }


      // ==========================================
      // アカウント追加
      // POST /api/accounts
      // ==========================================

      if (
        pathname === "/api/accounts" &&
        request.method === "POST"
      ) {
        const data = await getJson(request);

        if (
          !data ||
          typeof data.username !== "string" ||
          !data.username.trim()
        ) {
          return jsonResponse(
            {
              success: false,
              error: "ユーザー名を入力してください"
            },
            400
          );
        }

        const username = data.username.trim();

        const xUrl =
          typeof data.x_url === "string"
            ? data.x_url.trim()
            : null;

        const rssUrl =
          typeof data.rss_url === "string"
            ? data.rss_url.trim()
            : null;

        const enabled =
          data.enabled === 0 ||
          data.enabled === false
            ? 0
            : 1;

        const result = await env.DB
          .prepare(
            `INSERT INTO accounts
             (username, x_url, rss_url, enabled)
             VALUES (?, ?, ?, ?)`
          )
          .bind(
            username,
            xUrl,
            rssUrl,
            enabled
          )
          .run();

        return jsonResponse({
          success: true,
          id: result.meta.last_row_id
        });
      }


      // ==========================================
      // アカウント変更
      // PUT /api/accounts/:id
      // ==========================================

      const accountMatch =
        pathname.match(/^\/api\/accounts\/(\d+)$/);

      if (
        accountMatch &&
        request.method === "PUT"
      ) {
        const id = Number(accountMatch[1]);
        const data = await getJson(request);

        if (
          !data ||
          typeof data.username !== "string" ||
          !data.username.trim()
        ) {
          return jsonResponse(
            {
              success: false,
              error: "ユーザー名を入力してください"
            },
            400
          );
        }

        const username = data.username.trim();

        const xUrl =
          typeof data.x_url === "string"
            ? data.x_url.trim()
            : null;

        const rssUrl =
          typeof data.rss_url === "string"
            ? data.rss_url.trim()
            : null;

        const enabled =
          data.enabled === 0 ||
          data.enabled === false
            ? 0
            : 1;

        const result = await env.DB
          .prepare(
            `UPDATE accounts
             SET username = ?,
                 x_url = ?,
                 rss_url = ?,
                 enabled = ?
             WHERE id = ?`
          )
          .bind(
            username,
            xUrl,
            rssUrl,
            enabled,
            id
          )
          .run();

        if (!result.meta.changes) {
          return jsonResponse(
            {
              success: false,
              error: "アカウントが見つかりません"
            },
            404
          );
        }

        return jsonResponse({
          success: true,
          id
        });
      }


      // ==========================================
      // アカウント削除
      // DELETE /api/accounts/:id
      // ==========================================

      if (
        accountMatch &&
        request.method === "DELETE"
      ) {
        const id = Number(accountMatch[1]);

        const result = await env.DB
          .prepare(
            `DELETE FROM accounts
             WHERE id = ?`
          )
          .bind(id)
          .run();

        if (!result.meta.changes) {
          return jsonResponse(
            {
              success: false,
              error: "アカウントが見つかりません"
            },
            404
          );
        }

        return jsonResponse({
          success: true,
          id
        });
      }


      // ==========================================
      // その他のアクセス
      // ==========================================

      const result = await run(env);

      return jsonResponse(result);

    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error.message
        },
        500
      );
    }
  },


  // ==========================================
  // Cronで毎日自動実行
  // ==========================================

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(run(env));
  }
};
