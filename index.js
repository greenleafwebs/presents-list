async function run(env) {
  // D1から有効なアカウントのRSSを取得
  const { results: accounts } = await env.DB
    .prepare(`
      SELECT id, username, rss_url
      FROM accounts
      WHERE enabled = 1
        AND rss_url IS NOT NULL
        AND rss_url != ''
      ORDER BY id ASC
    `)
    .all();

  // D1からキーワードを取得
  const { results: keywords } = await env.DB
    .prepare("SELECT keyword FROM keywords")
    .all();

  let totalItems = 0;
  let savedCount = 0;
  let feedCount = 0;

  for (const account of accounts) {
    try {
      const response = await fetch(account.rss_url);

      if (!response.ok) {
        continue;
      }

      const rss = await response.text();

      const items =
        rss.match(/<item>[\s\S]*?<\/item>/g) || [];

      totalItems += items.length;
      feedCount++;

      for (const item of items) {
        // URL
        const linkMatch =
          item.match(/<link>([\s\S]*?)<\/link>/);

        const postUrl = linkMatch
          ? linkMatch[1].trim()
          : null;

        if (!postUrl) continue;

        // タイトル
        const titleMatch =
          item.match(/<title>([\s\S]*?)<\/title>/);

        const title = titleMatch
          ? titleMatch[1]
              .replace(/<!\[CDATA\[|\]\]>/g, "")
              .replace(/\s+/g, " ")
              .trim()
          : "";

        // 本文
        const descriptionMatch =
          item.match(
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

        // キーワード一致確認
        const matched = keywords.some(row => {
          const keyword =
            row.keyword.toLowerCase();

          return searchText.includes(keyword);
        });

        if (!matched) continue;

        // 保存
        const result = await env.DB
          .prepare(`
            INSERT OR IGNORE INTO posts
              (post_url, text)
            VALUES (?, ?)
          `)
          .bind(postUrl, description)
          .run();

        if (result.meta.changes) {
          savedCount++;
        }
      }

    } catch (error) {
      // 1つのRSS取得失敗で全体を止めない
      console.error(
        `RSS取得失敗: ${account.username}`,
        error
      );
    }
  }

  return {
    success: true,
    accounts: accounts.length,
    feeds: feedCount,
    rssItems: totalItems,
    keywords: keywords.map(k => k.keyword),
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
        "Content-Type":
          "application/json; charset=UTF-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type"
      }
    }
  );
}


// JSON取得
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

      // CORS
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
      // RSS手動取得
      // ==========================================

      if (
        pathname === "/api/run" &&
        request.method === "POST"
      ) {
        const result = await run(env);

        return jsonResponse(result);
      }


      // ==========================================
      // 投稿一覧
      // ==========================================

      if (
        pathname === "/api/posts" &&
        request.method === "GET"
      ) {
        const { results } = await env.DB
          .prepare(`
            SELECT post_url, text
            FROM posts
            ORDER BY rowid DESC
            LIMIT 100
          `)
          .all();

        return jsonResponse({
          success: true,
          posts: results
        });
      }


      // ==========================================
      // キーワード一覧
      // ==========================================

      if (
        pathname === "/api/keywords" &&
        request.method === "GET"
      ) {
        const { results } = await env.DB
          .prepare(`
            SELECT rowid AS id, keyword
            FROM keywords
            ORDER BY rowid ASC
          `)
          .all();

        return jsonResponse({
          success: true,
          keywords: results
        });
      }


      // ==========================================
      // キーワード追加
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
          return jsonResponse({
            success: false,
            error: "キーワードを入力してください"
          }, 400);
        }

        const keyword = data.keyword.trim();

        const result = await env.DB
          .prepare(`
            INSERT INTO keywords (keyword)
            VALUES (?)
          `)
          .bind(keyword)
          .run();

        return jsonResponse({
          success: true,
          id: result.meta.last_row_id,
          keyword
        });
      }


      // ==========================================
      // キーワード変更・削除
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
          return jsonResponse({
            success: false,
            error: "キーワードを入力してください"
          }, 400);
        }

        const keyword = data.keyword.trim();

        const result = await env.DB
          .prepare(`
            UPDATE keywords
            SET keyword = ?
            WHERE rowid = ?
          `)
          .bind(keyword, id)
          .run();

        if (!result.meta.changes) {
          return jsonResponse({
            success: false,
            error: "キーワードが見つかりません"
          }, 404);
        }

        return jsonResponse({
          success: true,
          id,
          keyword
        });
      }


      if (
        keywordMatch &&
        request.method === "DELETE"
      ) {
        const id = Number(keywordMatch[1]);

        const result = await env.DB
          .prepare(`
            DELETE FROM keywords
            WHERE rowid = ?
          `)
          .bind(id)
          .run();

        if (!result.meta.changes) {
          return jsonResponse({
            success: false,
            error: "キーワードが見つかりません"
          }, 404);
        }

        return jsonResponse({
          success: true,
          id
        });
      }


      // ==========================================
      // アカウント一覧
      // ==========================================

      if (
        pathname === "/api/accounts" &&
        request.method === "GET"
      ) {
        const { results } = await env.DB
          .prepare(`
            SELECT
              id,
              username,
              x_url,
              rss_url,
              enabled
            FROM accounts
            ORDER BY id ASC
          `)
          .all();

        return jsonResponse({
          success: true,
          accounts: results
        });
      }


      // ==========================================
      // アカウント追加
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
          return jsonResponse({
            success: false,
            error: "ユーザー名を入力してください"
          }, 400);
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
          data.enabled === false ||
          data.enabled === 0
            ? 0
            : 1;

        const result = await env.DB
          .prepare(`
            INSERT INTO accounts
              (username, x_url, rss_url, enabled)
            VALUES (?, ?, ?, ?)
          `)
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
          return jsonResponse({
            success: false,
            error: "ユーザー名を入力してください"
          }, 400);
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
          data.enabled === false ||
          data.enabled === 0
            ? 0
            : 1;

        const result = await env.DB
          .prepare(`
            UPDATE accounts
            SET
              username = ?,
              x_url = ?,
              rss_url = ?,
              enabled = ?
            WHERE id = ?
          `)
          .bind(
            username,
            xUrl,
            rssUrl,
            enabled,
            id
          )
          .run();

        if (!result.meta.changes) {
          return jsonResponse({
            success: false,
            error: "アカウントが見つかりません"
          }, 404);
        }

        return jsonResponse({
          success: true,
          id
        });
      }


      // ==========================================
      // アカウント削除
      // ==========================================

      if (
        accountMatch &&
        request.method === "DELETE"
      ) {
        const id = Number(accountMatch[1]);

        const result = await env.DB
          .prepare(`
            DELETE FROM accounts
            WHERE id = ?
          `)
          .bind(id)
          .run();

        if (!result.meta.changes) {
          return jsonResponse({
            success: false,
            error: "アカウントが見つかりません"
          }, 404);
        }

        return jsonResponse({
          success: true,
          id
        });
      }


      // ==========================================
      // その他
      // ==========================================

      return jsonResponse({
        success: false,
        error: "Not Found"
      }, 404);


    } catch (error) {
      console.error(error);

      return jsonResponse({
        success: false,
        error: error.message
      }, 500);
    }
  },


  // ==========================================
  // Cron
  // ==========================================

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(run(env));
  }

};
