# Sauna Finder - Search API v7

料金判定を強化した検索APIです。

- 時間制料金（60分/90分/120分など）を優先して解析
- 入浴料＋サウナ料金を合算
- 延長・会員・タオル・岩盤浴・食事などの料金は最低利用料金にしない
- 料金条件指定時は、料金の意味まで確認できた施設だけ採用
- 最低利用料金が条件を超える施設はAPI側で除外
- `price`, `priceLabel`, `priceType`, `priceDuration`, `priceVerified` を返します

`api/search.js` を既存のVercelプロジェクトの同じ場所に置き換えてください。
