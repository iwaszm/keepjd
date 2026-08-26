UPDATE products
SET
  created_at = substr(created_at, 1, 10),
  updated_at = substr(updated_at, 1, 10),
  title = NULL;