UPDATE products
SET title = NULL;

UPDATE price_points
SET captured_at = substr(captured_at, 1, 10)
WHERE length(captured_at) > 10;

DELETE FROM price_points
WHERE id NOT IN (
  SELECT MIN(id)
  FROM price_points
  GROUP BY product_id, captured_at
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_price_points_product_day
  ON price_points(product_id, captured_at);