# apify.com 验收摘要

生成时间：2026-10-14T05:43:09.891Z
全站多视口状态：全站验证早于克隆产物；评分版本：1

| 指标 | 数值 |
| --- | ---: |
| 侦察发现（唯一 URL） | 122 |
| 计划克隆（唯一 URL） | 120 |
| 计划内已有克隆 | 120 |
| 实际克隆产物 | 120 |
| v2 完整验证 | 0 |
| 未完整验证（目标并集） | 123 |
| 历史口径逐页结果 | 20 |
| v2 部分测量 | 0 |
| 最差视口低于 85% 的 v2 页面 | 0 |
| 视觉资源缺口 | 未生成 / 不可统计 |
| 全部资源引用缺口 | 未生成 / 不可统计 |
| 本地化失败 | 85 |
| 缺失本地引用 | 0 |
| 回原站链接 | 1522 |
| 队列失败 | 0 |

未完整验证的目标 = 侦察、队列及当前克隆产物的唯一 URL 并集，减去当前产物对应的 v2 完整验证。
本摘要不等同离线 strict、认证流程或外部部署验收。

## 证据状态

| 来源 | 状态 | 路径 |
| --- | --- | --- |
| 侦察 | 已生成 | GET /static/apify.com/recon/atlas.json |
| 计划队列 | 已生成 | GET /static/apify.com/queue.json |
| 克隆产物 | 已生成 | GET /api/pages/apify.com |
| 多视口验证 | 需重跑 | GET /static/apify.com/verify/verify-summary.json |
| 资产扫描 | 需重跑 | GET /static/apify.com/audit/asset-gaps.json |
| 站内接线 | 已生成 | GET /static/apify.com/linker-report.json |

## 失败及缺口

- 接线资产 · apidojo-tiktok-scraper：1 个本地化失败（linker-report.json）
- 接线资产 · apidojo-tweet-scraper：1 个本地化失败（linker-report.json）
- 接线资产 · apify-cheerio-scraper：1 个本地化失败（linker-report.json）
- 接线资产 · apify-facebook-ads-scraper：2 个本地化失败（linker-report.json）
- 接线资产 · apify-google-search-scraper：2 个本地化失败（linker-report.json）
- 接线资产 · apify-google-search-scraper-examples-build-a-b2b-prospect-li：1 个本地化失败（linker-report.json）
- 接线资产 · apify-instagram-hashtag-scraper-examples-find-instagram-infl：1 个本地化失败（linker-report.json）
- 接线资产 · apify-instagram-post-scraper：2 个本地化失败（linker-report.json）
- 接线资产 · apify-instagram-profile-scraper：1 个本地化失败（linker-report.json）
- 接线资产 · apify-web-fetch：2 个本地化失败（linker-report.json）
- 接线资产 · apimaestro-linkedin-profile-posts：1 个本地化失败（linker-report.json）
- 接线资产 · axesso\_data-amazon-reviews-scraper：2 个本地化失败（linker-report.json）
- 接线资产 · clockworks-free-tiktok-scraper：2 个本地化失败（linker-report.json）
- 接线资产 · clockworks-tiktok-profile-scraper-examples-build-tiktok-infl：1 个本地化失败（linker-report.json）
- 接线资产 · clockworks-tiktok-scraper-examples-tiktok-email-finder：1 个本地化失败（linker-report.json）
- 接线资产 · compass-crawler-google-places-examples-get-a-local-b2b-leads：2 个本地化失败（linker-report.json）
- 接线资产 · compass-google-maps-extractor：2 个本地化失败（linker-report.json）
- 接线资产 · compass-google-maps-extractor-examples-build-a-b2b-lead-list：2 个本地化失败（linker-report.json）
- 接线资产 · curious\_coder-facebook-ads-library-scraper：1 个本地化失败（linker-report.json）
- 接线资产 · curious\_coder-linkedin-jobs-scraper：1 个本地化失败（linker-report.json）
- 接线资产 · data-for-generative-ai：2 个本地化失败（linker-report.json）
- 接线资产 · dev\_fusion-linkedin-profile-scraper：1 个本地化失败（linker-report.json）
- 接线资产 · fatihtahta-reddit-scraper-search-fast：1 个本地化失败（linker-report.json）
- 接线资产 · harvestapi-linkedin-company：1 个本地化失败（linker-report.json）
- 接线资产 · harvestapi-linkedin-company-employees：1 个本地化失败（linker-report.json）
- 接线资产 · harvestapi-linkedin-company-posts：1 个本地化失败（linker-report.json）
- 接线资产 · harvestapi-linkedin-post-reactions：2 个本地化失败（linker-report.json）
- 接线资产 · harvestapi-linkedin-post-search：1 个本地化失败（linker-report.json）
- 接线资产 · harvestapi-linkedin-profile-posts：1 个本地化失败（linker-report.json）
- 接线资产 · harvestapi-linkedin-profile-scraper：1 个本地化失败（linker-report.json）
- 接线资产 · harvestapi-linkedin-profile-search：1 个本地化失败（linker-report.json）
- 接线资产 · hirebase-job-search：1 个本地化失败（linker-report.json）
- 接线资产 · igview-owner-threads-search-scraper：1 个本地化失败（linker-report.json）
- 接线资产 · memo23-allegro-scraper：1 个本地化失败（linker-report.json）
- 接线资产 · memo23-facebook-ads-library-scraper-ppe：1 个本地化失败（linker-report.json）
- 接线资产 · memo23-facebook-search-scraper：1 个本地化失败（linker-report.json）
- 接线资产 · partners-open-source-fair-share：2 个本地化失败（linker-report.json）
- 接线资产 · pequod-labs-company-decision-maker-finder：2 个本地化失败（linker-report.json）
- 接线资产 · scraping\_solutions-instagram-scraper-followers-following-no-：1 个本地化失败（linker-report.json）
- 接线资产 · store-categories：2 个本地化失败（linker-report.json）
- 接线资产 · store-categories-agents：1 个本地化失败（linker-report.json）
- 接线资产 · store-categories-ai：2 个本地化失败（linker-report.json）
- 接线资产 · store-categories-ecommerce-scrapers：2 个本地化失败（linker-report.json）
- 接线资产 · store-categories-lead-generation：2 个本地化失败（linker-report.json）
- 接线资产 · store-categories-seo-tools：2 个本地化失败（linker-report.json）
- 接线资产 · store-categories-social-media-scrapers：2 个本地化失败（linker-report.json）
- 接线资产 · store-collections-finance-tools：3 个本地化失败（linker-report.json）
- 接线资产 · store-collections-hospitality-tools：1 个本地化失败（linker-report.json）
- 接线资产 · store-collections-mcp-connectors：1 个本地化失败（linker-report.json）
- 接线资产 · store-collections-rising-star：1 个本地化失败（linker-report.json）
- 接线资产 · streamers-youtube-scraper：2 个本地化失败（linker-report.json）
- 接线资产 · streamers-youtube-scraper-examples-find-youtube-influencers：1 个本地化失败（linker-report.json）
- 接线资产 · templates-js-start：1 个本地化失败（linker-report.json）
- 接线资产 · templates-python-start：1 个本地化失败（linker-report.json）
- 接线资产 · templates-ts-start：2 个本地化失败（linker-report.json）
- 接线资产 · trudax-reddit-scraper-lite：1 个本地化失败（linker-report.json）
- 接线资产 · voyager-booking-scraper-examples-build-a-hotel-and-accommoda：2 个本地化失败（linker-report.json）
- 接线资产 · web-scraping：2 个本地化失败（linker-report.json）
- 接线资产 · zen-studio-shopee-product-scraper：2 个本地化失败（linker-report.json）
