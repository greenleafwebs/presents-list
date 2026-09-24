-- presents-list: postsテーブルにRSS投稿日を追加
ALTER TABLE posts ADD COLUMN published_at TEXT;

-- 既存データは投稿日が分からないためNULLのままにする。
-- 新しいRSS取得分からpublished_atが保存される。
