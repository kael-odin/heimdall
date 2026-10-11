/**
 * 唯一的 User-Agent —— **唯一实现**
 *
 * 它原本在 13 个文件里逐字复制了 14 份（`const UA = 'Mozilla/5.0 … Chrome/126…'`）。
 * 复制出来的常量迟早会漂移，而这一份漂移的代价特别隐蔽：**同一批产物里，
 * 原站截图用一个 UA、镜像截图用另一个** —— 分数会变，但没有任何东西报错。
 * 更别提反爬站点会对不同 UA 返回不同内容，"复刻得像不像"就再也说不清了。
 *
 * ⚠ `live/serve.mjs` 与 `live/har.mjs` **不从这里 import**：它们会被原样拷进交付包，
 * 包里只有这两个文件，任何指向上级的 import 都会让部署出去的服务一启动就
 * `Cannot find module`（见 test/bundle-selfcontained.test.mjs）。那两处各自保留本地副本，
 * 并有测试盯着它们与这里的值一致。
 */
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
