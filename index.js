// 管理画面の認証
const ADMIN_COOKIE = "presents_admin";
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;

function base64UrlEncode(value) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}

async function signAdminSession(payload, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\async function run(env) {");
  const match = header.match(new RegExp("(?:^|;\\s*)" + escaped + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

async function isAdminAuthenticated(request, env) {
  const cookie = getCookie(request, ADMIN_COOKIE);
  if (!cookie || !env.ADMIN_PASSWORD) return false;
  const parts = cookie.split(".");
  if (parts.length !== 2) return false;
  try {
    const payload = base64UrlDecode(parts[0]);
    const data = JSON.parse(payload);
    const timestamp = Number(data.t);
    if (!Number.isFinite(timestamp) || Date.now() - timestamp > ADMIN_SESSION_MS || Date.now() < timestamp) return false;
    const expected = await signAdminSession(parts[0], env.ADMIN_PASSWORD);
    if (expected.length !== parts[1].length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts[1].charCodeAt(i);
    return diff === 0;
  } catch { return false; }
}

async function createAdminCookie(env) {
  const payload = base64UrlEncode(JSON.stringify({ t: Date.now() }));
  const signature = await signAdminSession(payload, env.ADMIN_PASSWORD);
  return ADMIN_COOKIE + "=" + payload + "." + signature + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + (ADMIN_SESSION_MS / 1000);
}

function clearAdminCookie() {
  return ADMIN_COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}
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

        // 投稿日時
        const pubDateMatch =
          item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) ||
          item.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i);

        const publishedAt = pubDateMatch
          ? toSqliteDateTime(pubDateMatch[1])
          : null;

        // 投稿日時が取得できない記事は、
        // 7日表示の対象にできないため保存しない。
        if (!publishedAt) continue;

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
              (post_url, text, published_at)
            VALUES (?, ?, ?)
          `)
          .bind(postUrl, description, publishedAt)
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


// RSSの日時をD1/SQLiteで扱いやすいUTC日時へ変換
function toSqliteDateTime(value) {
  const date = new Date(String(value || "").trim());

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
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


// 入力されたURLの種別を判定し、保存先のカラムを決める
function classifySourceUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return {
      error: "X または RSS の URLを入力してください"
    };
  }

  const sourceUrl = value.trim();
  let url;

  try {
    url = new URL(sourceUrl);
  } catch {
    return {
      error: "有効なURLを入力してください"
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      error: "http または https のURLを入力してください"
    };
  }

  const hostname = url.hostname.toLowerCase();
  const isXUrl =
    hostname === "x.com" ||
    hostname.endsWith(".x.com") ||
    hostname === "twitter.com" ||
    hostname.endsWith(".twitter.com");

  return isXUrl
    ? { xUrl: sourceUrl, rssUrl: null }
    : { xUrl: null, rssUrl: sourceUrl };
}


// 現在のキーワードに一致しないキャッシュ済み投稿を削除する
async function removePostsWithoutKeywords(env) {
  const { results: keywords } = await env.DB
    .prepare("SELECT keyword FROM keywords")
    .all();

  const activeKeywords = keywords
    .map(row => row.keyword.trim().toLowerCase())
    .filter(Boolean);

  if (activeKeywords.length === 0) {
    await env.DB
      .prepare("DELETE FROM posts")
      .run();
    return;
  }

  const conditions = activeKeywords
    .map(() => "LOWER(text) LIKE ?")
    .join(" OR ");

  await env.DB
    .prepare(`
      DELETE FROM posts
      WHERE NOT (${conditions})
    `)
    .bind(...activeKeywords.map(keyword => `%${keyword}%`))
    .run();
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
      // 管理画面ログイン
      // ==========================================

      if (
        pathname === "/api/admin/login" &&
        request.method === "POST"
      ) {
        const data = await getJson(request);

        if (!env.ADMIN_PASSWORD) {
          return jsonResponse({
            success: false,
            error: "管理パスワードが設定されていません"
          }, 500);
        }

        if (
          !data ||
          typeof data.password !== "string" ||
          data.password !== env.ADMIN_PASSWORD
        ) {
          return jsonResponse({
            success: false,
            error: "パスワードが違います"
          }, 401);
        }

        return new Response(
          JSON.stringify({ success: true }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=UTF-8",
              "Set-Cookie": await createAdminCookie(env)
            }
          }
        );
      }

      if (
        pathname === "/api/admin/logout" &&
        request.method === "POST"
      ) {
        return new Response(
          JSON.stringify({ success: true }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=UTF-8",
              "Set-Cookie": clearAdminCookie()
            }
          }
        );
      }

      const adminApi =
        pathname === "/api/run" ||
        pathname === "/api/accounts" ||
        /^\/api\/accounts\/\d+$/.test(pathname) ||
        (
          pathname === "/api/keywords" &&
          request.method !== "GET"
        ) ||
        (
          /^\/api\/keywords\/\d+$/.test(pathname) &&
          request.method !== "GET"
        );

      if (adminApi && !(await isAdminAuthenticated(request, env))) {
        return jsonResponse({
          success: false,
          error: "管理画面へのログインが必要です"
        }, 401);
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
            WHERE datetime(published_at) >= datetime('now', '-7 days')
            ORDER BY datetime(published_at) DESC
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

        await removePostsWithoutKeywords(env);

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

        await removePostsWithoutKeywords(env);

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

        const source = classifySourceUrl(data.source_url);

        if (source.error) {
          return jsonResponse({
            success: false,
            error: source.error
          }, 400);
        }

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
            source.xUrl,
            source.rssUrl,
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

        const source = classifySourceUrl(data.source_url);

        if (source.error) {
          return jsonResponse({
            success: false,
            error: source.error
          }, 400);
        }

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
            source.xUrl,
            source.rssUrl,
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

        // 変更前のアカウント由来の投稿を残さないよう、
        // 次回RSS取得まで投稿キャッシュを空にする。
        await env.DB
          .prepare("DELETE FROM posts")
          .run();

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

        // 投稿テーブルに取得元アカウントを保持していないため、
        // 削除したアカウントの投稿を残さないようキャッシュを破棄する。
        await env.DB
          .prepare("DELETE FROM posts")
          .run();

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
