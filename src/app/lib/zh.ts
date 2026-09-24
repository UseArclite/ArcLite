/**
 * Simplified Chinese, keyed on the English source.
 *
 * Written rather than transliterated. A few decisions worth recording, because they recur:
 *
 *   * **暗池** for the venue. It is the established term for a private trading venue in Chinese
 *     financial writing, and inventing something softer would only make the page harder to read
 *     for the people it is written for.
 *   * **批量撮合 / 撮合** for batch and matching — 撮合 is the ordinary exchange word for pairing
 *     orders, not a coinage.
 *   * **密封 / 已密封** for sealed. Kept consistent everywhere so the same concept never appears
 *     under two words in one page.
 *   * **份额** for raw units, and **参考价** for the reference price.
 *   * Brand and ticker names stay Latin: ArcLite, NVDA, USDG, Chainlink, Robinhood Chain. A
 *     reader looking for these is looking for the letters.
 *
 * A missing entry renders the English, which is a visible gap rather than a blank one.
 */

export const zh: Record<string, string> = {
  // ---------------------------------------------------------------------------------------
  // Navigation and chrome
  // ---------------------------------------------------------------------------------------
  Experience: "体验",
  Protocol: "协议",
  Assets: "资产",
  Proofs: "证明",
  Docs: "文档",
  Dashboard: "控制台",
  Menu: "菜单",
  "THE ARCLITE CHAPTERS": "ARCLITE 章节",
  "Explore the experience, protocol, assets, proofs and dashboard.":
    "浏览体验、协议、资产、证明与控制台。",
  "PRIVATE EXECUTION.<br/>REAL-WORLD VALUE.": "私密执行。<br/>真实世界价值。",
  "Explore ArcLite": "浏览 ArcLite",
  "Back to the heavens ↑": "回到天际 ↑",
  "Protocol in development. Access is subject to asset availability, screening and jurisdiction eligibility.":
    "协议仍在开发中。使用权取决于资产可用性、合规审查与司法辖区资格。",
  "Coming soon.": "敬请期待。",
  "Back to the experience": "返回体验",
  "← Back to the experience": "← 返回体验",
  "The venue is live on Robinhood Chain. Open the dashboard to connect a wallet.":
    "交易场所已在 Robinhood Chain 上线。打开控制台即可连接钱包。",
  "CONTINUE THE EXPERIENCE": "继续体验",
  Language: "语言",
  English: "English",
  Chinese: "中文",

  // ---------------------------------------------------------------------------------------
  // Home
  // ---------------------------------------------------------------------------------------
  "THE AGE OF": "属于",
  "PRIVATE EXECUTION. REAL-WORLD VALUE.": "私密执行。真实世界价值。",
  "PRIVATE ≠ UNACCOUNTABLE": "私密 ≠ 不可问责",
  "Public solvency": "公开的偿付能力",
  "Explore public proofs": "查看公开证明",
  "Asset-aware windows": "感知资产状态的窗口",
  "Understand the guards": "了解保护机制",
  "A staged rollout": "分阶段推出",
  "Read the roadmap": "阅读路线图",
  "THE ASSET COLLECTION": "资产集合",
  "EXPLORE THE ASSETS": "浏览资产",
  "ARCLITE / REAL-WORLD ASSETS": "ARCLITE / 真实世界资产",

  // ---------------------------------------------------------------------------------------
  // Home — the narrative chapters
  // ---------------------------------------------------------------------------------------
  "Scroll to enter": "向下滚动进入",
  "A NEW CHAPTER": "私密 RWA 交易的",
  "IN PRIVATE RWA TRADING": "全新篇章",
  "STOCKS. TREASURIES.": "股票。国债。",
  "A SHARED HORIZON.": "同一片地平线。",
  "I — THE THRESHOLD": "一 —— 门槛",
  "Real-world assets.": "真实世界资产。",
  "Beyond the visible.": "超越可见之处。",
  "Every order begins with an intention.": "每一笔订单都始于一个意图。",
  "Some things are better kept to yourself.": "有些事，留给自己更好。",
  "ArcLite is designed for tokenized stocks and ETFs to meet treasury assets in a screened private pool.":
    "ArcLite 让代币化股票与 ETF，在一个经过审查的私密资金池中与国债类资产相遇。",
  "Your order enters sealed.": "你的订单密封进入。",
  "The market sees no individual intent.": "市场看不到任何个体意图。",
  "THE MARKET, RECONSIDERED": "重新构想的市场",
  "Real-world value.": "真实世界的价值。",
  "On both sides.": "两端皆然。",
  "ArcLite is a private trading protocol designed around real-world assets. Tokenized stocks and ETFs cross against tokenized treasuries, so the quote side of a trade can remain invested in a treasury asset.":
    "ArcLite 是一个围绕真实世界资产设计的私密交易协议。代币化股票与 ETF 同代币化国债撮合，因此交易的计价一端可以始终保持在国债资产中。",
  "Orders gather in sealed batches. Matched size crosses at guarded reference prices, while public proofs and controlled disclosure support accountability.":
    "订单汇聚成密封批次。成交量按受保护的参考价撮合，同时以公开证明与受控披露支撑可问责性。",
  "READ THE PROTOCOL": "阅读协议",
  "A screened pool.": "经过审查的资金池。",
  "Eligible assets enter through a registry. Access is subject to screening, asset rules and jurisdiction eligibility.":
    "合格资产通过注册表进入。使用权取决于合规审查、资产规则与司法辖区资格。",
  "A guarded price.": "受保护的价格。",
  "Stale references, multiplier changes and relevant corporate actions can defer an asset\u2019s trading window.":
    "参考价过期、乘数变更以及相关公司行动，都可能使某项资产的交易窗口延后。",
  "A treasury balance.": "国债余额。",
  "Resting treasury notes track published fund value. Raw units stay constant as NAV updates their reference value.":
    "静置的国债票据跟随公布的基金价值。净值更新的是参考价值，份额本身保持不变。",
  Stocks: "股票",
  Treasuries: "国债",
  "One private venue.": "同一个私密场所。",
  "The proposed core pairs tokenized equities with a treasury quote asset. Each side has its own reference source and eligibility requirements.":
    "设计中的核心机制，将代币化股票与国债计价资产配对。每一侧都有各自的参考价来源与准入条件。",
  "Privacy, with": "私密，但",
  "Epoch-level proofs are designed to demonstrate the pool\u2019s solvency without publishing every order.":
    "周期级证明用于展示资金池的偿付能力，而无需公开每一笔订单。",
  "The scheduler accounts for reference freshness, issuer multiplier updates, ex-dates and NAV publication times.":
    "调度器会考虑参考价的时效性、发行方乘数更新、除权日与净值公布时间。",
  "Core stock\u2013treasury crossing comes first. Stock pairs, bounded backstop liquidity and RFQ blocks are described as later stages.":
    "首先是核心的股票—国债撮合。股票对、有上限的后备流动性与 RFQ 大宗交易属于后续阶段。",
  "II — THE CROSSING": "二 —— 撮合",
  "Intent stays private.": "意图始终私密。",
  "Orders enter a sealed batch. The protocol matches eligible size against a common reference, without exposing individual orders in a public order book.":
    "订单进入一个密封批次。协议按统一参考价撮合合格数量，不会在公开订单簿中暴露任何单笔订单。",
  "Stocks reference oracle prices and issuer adjustments. Treasuries reference published fund NAV.":
    "股票参考预言机价格与发行方调整。国债参考公布的基金净值。",
  "III — THE RESERVE": "三 —— 储备",
  "Value does not stand still.": "价值从不静止。",
  "The treasury is the quote asset. A resting balance is valued as raw units multiplied by published NAV, inside the private pool.":
    "国债即计价资产。静置余额的估值，是私密资金池内的份额乘以公布的净值。",
  "No fixed APY. No projected yield. Published fund value provides the reference.":
    "没有固定年化。没有预期收益。参考值来自公布的基金价值。",
  "IV — THE REVELATION": "四 —— 揭示",
  "Public epoch proofs demonstrate the pool\u2019s solvency. Individual orders remain private, with view keys available for controlled auditor disclosure.":
    "公开的周期证明展示资金池的偿付能力。单笔订单保持私密，并可通过查看密钥向审计方进行受控披露。",
  "A delayed aggregate tape reports the wider activity. Individual order intentions remain sealed.":
    "延迟发布的汇总行情反映整体活动。单笔订单的意图仍然密封。",
  "Inside the protocol.": "走进协议内部。",

  // ---------------------------------------------------------------------------------------
  // Contract address
  // ---------------------------------------------------------------------------------------
  "CA:": "合约地址：",
  Copied: "已复制",
  Soon: "敬请期待",
  TBA: "待公布",

  // ---------------------------------------------------------------------------------------
  // Dashboard chrome
  // ---------------------------------------------------------------------------------------
  "ARCLITE / PRIVATE EXECUTION TERMINAL": "ARCLITE / 私密执行终端",
  "The private market.": "私密市场。",
  "Sealed orders. Reference prices. Public proofs.": "密封订单。参考价格。公开证明。",
  "LIVE · ROBINHOOD CHAIN": "已上线 · ROBINHOOD CHAIN",
  "Live references · Real settlement": "实时参考价 · 真实结算",
  CONNECTING: "连接中",
  "Connecting to Robinhood Chain…": "正在连接 Robinhood Chain…",
  VENUE: "场所",
  EXECUTION: "执行",
  QUOTE: "计价",
  NETWORK: "网络",
  "SEALED BATCH": "密封批次",
  "ROBINHOOD CHAIN": "ROBINHOOD CHAIN",
  "CONNECTING…": "连接中…",
  Trade: "交易",
  Portfolio: "投资组合",
  "Proofs & activity": "证明与活动",
  "Dashboard views": "控制台视图",

  // Protocol and Assets
  "THE ORDER’S JOURNEY": "订单的旅程",
  "From the world.": "自世界而来。",
  "Into the private.": "步入私密之中。",
  "ArcLite brings eligible real-world assets into a private pool, then crosses matched orders in batches. Each stage has a distinct responsibility.":
    "ArcLite 将合格的真实世界资产引入私密资金池，再以批次撮合成交订单。每个阶段各司其职。",
  "ASSET-AWARE WINDOWS": "感知资产状态的窗口",
  "Know when": "知其可行之时",
  "A valid price is more than a number. The surrounding asset state matters.":
    "有效的价格不只是一个数字。它周围的资产状态同样重要。",
  "PROPOSED ROADMAP / IN DEVELOPMENT": "拟议路线图 / 开发中",
  "One chapter": "一章",
  "The source documents describe proposed architecture and staged plans. Features and integrations are not presented as live deployments.":
    "原始文档描述的是拟议架构与分阶段计划。其中的功能与集成并不代表已上线部署。",
  "The protocol.": "协议。",
  "A private path from intention to settlement.": "一条从意图到结算的私密路径。",
  "Sealed orders. Guarded references. Public pool-solvency proofs. Three parts of one proposed trading architecture.":
    "密封订单。受保护的参考价。公开的资金池偿付能力证明。同一套拟议交易架构的三个部分。",
  "THE REFERENCE": "参考价",
  "A price with a source.": "有来源的价格。",
  "The proposed pricing commitment includes a stock oracle round and issuer multiplier, or a treasury NAV and its publication time.":
    "拟议的定价承诺包含股票预言机轮次与发行方乘数，或国债净值及其公布时间。",
  "A common reference informs the crossing. Freshness and event guards determine whether an asset can participate.":
    "统一的参考价决定撮合。时效性与事件保护机制决定某项资产能否参与。",
  "The asset collection.": "资产集合。",
  "Stocks, carried": "股票，被带入",
  "Eligible tokenized stocks and ETFs enter through an asset registry. Their reference values depend on an oracle price and the issuer’s applicable multiplier.":
    "合格的代币化股票与 ETF 通过资产注册表进入。其参考价值取决于预言机价格与发行方适用的乘数。",
  Reference: "参考价",
  "Oracle × issuer multiplier": "预言机 × 发行方乘数",
  "Private representation": "私密表示",
  "Raw-unit asset notes": "以份额计的资产票据",
  "Event controls": "事件控制",
  "Ex-dates and multiplier updates": "除权日与乘数更新",
  "The venue lists every Robinhood tokenized equity that carries a Chainlink price feed — 35 of them today. An asset it cannot derive a guarded reference for is not eligible, however real it is.":
    "场所收录每一只带有 Chainlink 价格源的 Robinhood 代币化股票——目前共 35 只。无法为其推导出受保护参考价的资产即不合格，无论它多么真实。",
  "UNDERSTANDING TREASURY VALUE": "理解国债价值",
  "Units × NAV.": "份额 × 净值。",
  "Nothing invented.": "无一凭空杜撰。",
  "Published NAV is the valuation input. ArcLite does not need to invent a projected yield or fixed APY to show the reference value of treasury notes.":
    "公布的净值就是估值输入。ArcLite 无需编造预期收益或固定年化，即可展示国债票据的参考价值。",
  "AVAILABILITY & ACCESS": "可用性与准入",
  "Defined assets.": "明确的资产。",
  "Defined boundaries.": "明确的边界。",
  "Registry first": "注册表优先",
  "The proposed venue screens and registry-gates eligible assets. It is designed around securities-form RWAs, with jurisdiction restrictions including non-US eligibility in the source plans.":
    "拟议场所对合格资产进行审查并以注册表把关。其设计围绕证券形态的 RWA，原始方案中包含司法辖区限制，含非美国资格要求。",
  "Treasury availability": "国债可用性",
  "The proposed primary deployment is Robinhood Chain. Treasury contracts, NAV sources and price feeds require verification before the intended lane is available.":
    "拟议的主要部署环境是 Robinhood Chain。国债合约、净值来源与价格源需经验证，相应通道方可启用。",
  "The fallback quote": "备选计价资产",
  "USDG is the documented fallback if the intended treasury lane is unavailable at launch. Treasury NAV accrual should not be assumed for that fallback.":
    "若上线时国债通道尚不可用，文档中记载的备选方案是 USDG。不应假定该备选方案具备国债净值累积。",
  "The asset. The reference. The other side of the trade.": "资产。参考价。交易的另一端。",
  "ArcLite’s proposed core brings tokenized stocks and ETFs together with tokenized treasury quote assets.":
    "ArcLite 拟议的核心机制，将代币化股票与 ETF，同代币化国债计价资产结合在一起。",
  "02 / TOKENIZED TREASURIES": "02 / 代币化国债",
  "A different kind of quote.": "另一种计价方式。",
  "The intended quote asset is a treasury token. A stock sale can therefore receive treasury units, while resting quote balances remain valued against published fund NAV.":
    "设想中的计价资产是国债代币。因此卖出股票可以收到国债份额，而静置的计价余额仍按公布的基金净值估值。",
  "An accumulating treasury balance is valued as raw units × published NAV. Its unit count and reference value are different measures.":
    "不断累积的国债余额，其估值为份额 × 公布的净值。份额数量与参考价值是两个不同的量度。",
  "Public proofs. Private orders.": "公开证明。私密订单。",

  // Proofs
  "THREE VIEWS OF ONE POOL": "同一资金池的三种视角",
  "What is public.": "何为公开。",
  "What is private.": "何为私密。",
  "Different audiences need different information. ArcLite’s proposed architecture separates individual intentions from the evidence used to assess the pool.":
    "不同的受众需要不同的信息。ArcLite 拟议的架构，将个体意图与用于评估资金池的证据分离开来。",
  "Public epoch solvency": "公开的周期偿付能力",
  "Epoch-level solvency proofs demonstrate the pool’s solvency. Their role is accountability at the pool level, not publication of an individual trader’s order.":
    "周期级偿付能力证明用于展示资金池的偿付能力。它的作用是资金池层面的可问责性，而非公布某位交易者的订单。",
  "Controlled disclosure": "受控披露",
  "Auditor view keys support scoped access for the parties entitled to inspect relevant information. Privacy and permitted disclosure coexist.":
    "审计方查看密钥，为有权查阅相关信息的一方提供限定范围的访问。私密与获准的披露可以共存。",
  "Delayed aggregate tape": "延迟发布的汇总行情",
  "Published aggregates provide a delayed view of crossed activity. This differs from a public live order book that reveals individual trading intentions.":
    "公布的汇总数据提供成交活动的延迟视图。这与暴露个体交易意图的公开实时订单簿不同。",
  "A CLEARER VIEW": "更清晰的视角",
  "Visibility, by purpose.": "按用途划分的可见性。",
  PUBLIC: "公开",
  "Pool-level evidence": "资金池层面的证据",
  "Epoch solvency proofs and delayed aggregate trade activity.":
    "周期偿付能力证明，以及延迟发布的汇总交易活动。",
  CONTROLLED: "受控",
  "Auditor disclosure": "面向审计方的披露",
  "Information made available through authorized view keys.": "通过获授权的查看密钥所提供的信息。",
  PRIVATE: "私密",
  "Individual intentions": "个体意图",
  "Sealed order details inside the private trading process.": "私密交易流程内部的密封订单细节。",
  "The architecture is in development. These descriptions are drawn from the ArcLite product and backend specifications, not a claim of a completed audit or deployed proof system.":
    "该架构仍在开发中。以上描述取自 ArcLite 的产品与后端规格文档，并不代表已完成审计或已部署的证明系统。",
  "Prove. Don’t reveal.": "证明，而非揭露。",
  "Accountability in the open. Individual orders kept private.": "问责公开进行。单笔订单保持私密。",
  "Privacy in ArcLite includes screening, solvency proofs and controlled disclosure. It does not mean exemption from asset rules or accountability.":
    "ArcLite 所说的私密，包含合规审查、偿付能力证明与受控披露。它并不意味着可以豁免资产规则或问责。",
  "THE PUBLIC RECORD": "公开记录",
  "The proof leaves.<br/>The order stays.": "证明离开。<br/>订单留下。",
  "The public record concerns pool solvency and delayed aggregate activity. Individual orders stay within the private execution process.":
    "公开记录关乎资金池的偿付能力与延迟发布的汇总活动。单笔订单仍留在私密执行流程之内。",
  "The dashboard checks pool solvency live against Robinhood Chain: balanceOf(pool) against the units it owes, per asset. That is an on-chain check anyone can repeat, not a zero-knowledge proof, and the page says which it is.":
    "控制台会对照 Robinhood Chain 实时核对资金池的偿付能力：逐项资产比较 balanceOf(pool) 与其所欠份额。这是任何人都可以重复的链上核对，而非零知识证明，页面上也如实标明。",
  "Enter the dashboard.": "进入控制台。",

  // Docs
  "WHAT IT IS": "这是什么",
  "A private": "一个私密的",
  "ArcLite crosses tokenized real-world assets in sealed batches on Robinhood Chain. Orders are encrypted until the book closes, priced from references the contract reads itself, matched, proved, and settled on chain — with nothing per-order published.":
    "ArcLite 在 Robinhood Chain 上以密封批次撮合代币化真实世界资产。订单在订单簿关闭前始终加密，按合约自行读取的参考价定价，经撮合、证明后在链上结算——不公布任何单笔订单信息。",
  "Orders are sealed": "订单是密封的",
  "An order is built and encrypted inside your browser and sent without a cookie or an address. What reaches the venue is a commitment and a ciphertext. Nothing in the request links it to your wallet.":
    "订单在你的浏览器内构建并加密，发送时不带 cookie，也不带地址。抵达场所的只有一个承诺值和一段密文。请求中没有任何内容能将它与你的钱包关联。",
  "The book closes before prices are read": "先关闭订单簿，再读取价格",
  "Everyone crosses at one price": "所有人以同一个价格成交",
  "Within a window an asset has a single reference, taken from Chainlink and the issuer’s multiplier. There is no queue to be early in and no spread to be on the wrong side of. Where demand and supply do not match, fills are pro-rata.":
    "在一个窗口内，每项资产只有一个参考价，取自 Chainlink 与发行方乘数。这里没有需要抢先的排队，也没有会站错边的买卖价差。当供需不对等时，成交按比例分配。",
  "Settlement proves the crossing": "结算证明这次撮合",
  "A zero-knowledge proof shows the batch was consistent — notes existed, nothing was spent twice, value was conserved at the committed reference, no guarded asset crossed — without revealing a single order. The contract verifies it before anything moves.":
    "一份零知识证明表明该批次是自洽的——票据确实存在、没有任何一笔被重复花费、价值在承诺的参考价下守恒、没有受保护的资产参与撮合——而无需揭示任何一笔订单。合约会在任何资金变动之前验证它。",
  "WHAT IS PRIVATE": "什么是私密的",
  "Private is not": "私密并不等于",
  "Full zero-knowledge does not make a venue unaccountable, and it does not hide everything from everyone. This is who sees what, stated plainly, including the parts that are less private than the word suggests.":
    "完整的零知识并不会让一个交易场所不可问责，也不会对所有人隐藏一切。以下如实说明谁能看到什么，包括那些比字面上听起来更不私密的部分。",
  "The public sees commitments": "公众看到的是承诺值",
  "On chain: note commitments, nullifiers, Merkle roots, and the fact that a window settled. No asset, no size, no side, no counterparty, no address.":
    "链上可见：票据承诺值、作废标记、默克尔根，以及某个窗口已完成结算这一事实。没有资产、没有数量、没有买卖方向、没有对手方、没有地址。",
  "Deposits are visible, and always were": "存入是可见的，且一直如此",
  "The matcher sees one window": "撮合方只看到一个窗口",
  "Orders are decrypted to be matched, so the venue sees that window’s book in plaintext. It cannot see it before the book closes, and it cannot link your orders across windows — the account handle is salted per window by construction. Removing the single-window view entirely needs threshold decryption, which is not built.":
    "订单需要解密才能撮合，因此场所会以明文看到该窗口的订单簿。它无法在订单簿关闭前看到，也无法跨窗口关联你的订单——账户标识在设计上按窗口加盐。要彻底消除这种单窗口可见性，需要门限解密，而该功能尚未构建。",
  "Your own history needs your keys": "你的历史记录需要你的密钥",
  "Because orders are unlinkable across windows, there is no query for “this person’s trades”. Only the holder of the keys can assemble it — which is also why the vault can rebuild itself from the chain and a signature alone, on any browser.":
    "由于订单在跨窗口之间不可关联，并不存在“这个人的交易”这样一条查询。只有持有密钥的人才能把它拼起来——这也正是金库能够仅凭链上数据与一个签名，在任意浏览器上重建自身的原因。",
  "WHAT THE CHAIN ENFORCES": "链上强制执行的内容",
  "Checks, not promises.": "可核对，而非承诺。",
  SOLVENCY: "偿付能力",
  "Repeatable by anyone": "任何人都可重复核对",
  "Crossing moves no tokens — every unit a buyer receives comes from a seller in the same window — so the pool’s obligations change only on deposit and withdrawal. Solvency reduces to comparing its token balance against what it owes, per asset, directly on chain.":
    "撮合不会转移代币——买方收到的每一份额都来自同一窗口内的卖方——因此资金池的负债只在存入与提取时变化。偿付能力因而简化为：逐项资产，直接在链上比较其代币余额与所欠数额。",
  GUARDS: "保护机制",
  "Read, not set": "读取得来，而非人为设定",
  "An asset is deferred when its reference is stale, its oracle is paused, or a corporate action is in progress. The contract derives that itself from the feeds and the token, and a deferred asset rests while every other asset keeps crossing.":
    "当某项资产的参考价过期、预言机被暂停，或有公司行动正在进行时，该资产会被延后。合约会自行从价格源与代币读取并推导出这一点；被延后的资产暂停交易，其余资产照常撮合。",
  EXIT: "退出",
  Unconditional: "无条件",
  "Withdrawal is the one path with no pause, no role and no window check. It is also the smallest circuit in the system, deliberately, so that proving it stays something a laptop can do in seconds.":
    "提取是唯一一条没有暂停、没有角色限制、也不检查窗口的路径。它同时也是系统中最小的电路——这是刻意为之，好让生成它的证明始终是一台笔记本电脑几秒钟就能完成的事。",
  REFERENCE: "参考信息",
  "Where to": "到哪里",
  "The venue runs on Robinhood Chain, an Arbitrum Orbit L2. These are the contracts the dashboard reads, published so the solvency figures can be verified against the chain rather than taken from this page.":
    "该场所运行在 Robinhood Chain 上，这是一条 Arbitrum Orbit L2。以下是控制台读取的合约，公布出来是为了让偿付能力数据可以对照链上核实，而不是只能相信本页。",
  Network: "网络",
  "Robinhood Chain · 4663": "Robinhood Chain · 4663",
  "Quote asset": "计价资产",
  "USDG · 6 decimals": "USDG · 6 位小数",
  "Eligible universe": "合格资产范围",
  "Tokenized equities with a Chainlink feed": "带有 Chainlink 价格源的代币化股票",
  "Window length": "窗口时长",
  Pool: "资金池",
  "Asset registry": "资产注册表",
  "Price committer": "价格承诺合约",
  "Quote token": "计价代币",
  LIMITS: "局限",
  "What this is": "它不是",
  Unaudited: "未经审计",
  "The contracts and circuits have not been through an external audit. They are source-verified and tested, which is not the same thing.":
    "合约与电路尚未经过外部审计。它们已完成源码验证并通过测试，但这并非同一回事。",
  "A thin anonymity set": "匿名集合仍然稀薄",
  "Privacy comes from the crowd you hide in. Early on that crowd is small, and timing alone can correlate a deposit with a withdrawal. This improves only with use.":
    "私密来自你藏身其中的人群。早期这个人群还很小，仅凭时间就可能把一次存入与一次提取关联起来。这一点只会随着使用而改善。",
  "Issuer powers remain": "发行方权力依然存在",
  "The tokens are issued by a third party who can pause transfers globally, blocklist an address, or restate a multiplier. No venue can hold these assets and remove that.":
    "这些代币由第三方发行，对方可以全局暂停转账、将某个地址列入黑名单，或重新设定乘数。任何持有这些资产的场所都无法消除这一点。",
  "Proved consistent, not optimal": "证明的是自洽，而非最优",
  "The settlement proof shows a crossing was valid at the committed reference. It does not prove the matcher found the best possible crossing, and this page will not pretend otherwise.":
    "结算证明表明某次撮合在承诺的参考价下是有效的。它并不证明撮合方找到了最优的撮合方案，本页也不会假装如此。",
  "References come from Chainlink feeds, which update on a deviation threshold rather than continuously, so a window can legitimately cross slightly away from the live mid. An asset whose reference has gone stale is deferred rather than crossed on an old price. Access is subject to asset availability, screening and jurisdiction eligibility.":
    "参考价来自 Chainlink 价格源，它按偏离阈值更新而非持续更新，因此一个窗口的成交价可能合理地略微偏离实时中间价。参考价已过期的资产会被延后，而不会按旧价格撮合。使用权取决于资产可用性、合规审查与司法辖区资格。",
  "Documentation.": "文档。",
  "How the venue works, what it guarantees, and what it does not.":
    "场所如何运作、它保证什么，以及它不保证什么。",
  "A reference for reading the venue, not a description of it. Every figure below can be checked against Robinhood Chain.":
    "这是一份用于核对该场所的参考资料，而非对它的描述。下方每一个数字都可以对照 Robinhood Chain 核实。",
  "THE GUARANTEE THAT MATTERS": "真正重要的保证",
  "You can always leave.": "你随时可以离开。",
  "Withdrawal carries no pause, no role and no window check. The pool accepts a valid proof from anyone, so a holder can exit while the venue is stopped, the asset is delisted, and the operator is gone.":
    "提取没有暂停、没有角色限制，也不检查窗口。资金池接受来自任何人的有效证明，因此即使场所已停止运行、资产已下架、运营方已消失，持有者依然可以退出。",
  "The proof is generated in your browser, from keys that never leave it. A server that could prove your withdrawal could also spend your note — which is why no server has one.":
    "证明在你的浏览器中生成，所用密钥从不离开浏览器。一台能够为你的提取生成证明的服务器，同样也能花掉你的票据——这正是没有任何服务器持有它的原因。",
  "Open the dashboard.": "打开控制台。",

  // Fragments split around inline markup
  "Stocks.": "股票。",
  "Treasuries.": "国债。",
  "Shielding is an ordinary token transfer from a known address, so the link between a wallet and":
    "屏蔽存入是一次来自已知地址的普通代币转账，因此钱包与",

  // Dashboard
  "RWA × RWA": "RWA × RWA",
  "REFERENCE MARKET": "参考市场",
  "Tokenized asset": "代币化资产",
  "Issuer multiplier": "发行方乘数",
  "Price guard": "价格保护",
  "Reference freshness": "参考价时效",
  "Corporate action window": "公司行动窗口",
  Session: "交易时段",
  "Value moves. Units stay yours.": "价值会变。份额始终属于你。",
  "A note holds raw units. A reference price changes what those units are worth, not how many you have. Returns are not fixed or guaranteed.":
    "一张票据记录的是份额。参考价改变的是这些份额值多少钱，而不是你拥有多少份额。收益既不固定，也不受保证。",
  "PUBLIC ACCOUNTABILITY": "公开问责",
  "Verify the pool.": "核验资金池。",
  "Preserve the private.": "守护私密。",
  "Solvency is a check you can repeat": "偿付能力是一项你可以亲自重复的核对",
  "Pool solvency": "资金池偿付能力",
  LIVE: "实时",
  "Solvency is read live from Robinhood Chain and is a check anyone can repeat, not a proof we produced — crossing moves no tokens, so the pool’s obligations change only on deposit and withdrawal. The contracts are unaudited.":
    "偿付能力数据实时读取自 Robinhood Chain，是任何人都能重复的核对，而非我们生成的证明——撮合不转移代币，因此资金池的负债只在存入与提取时变化。合约未经审计。",
  "Reference prices, issuer multipliers, asset eligibility and guard state are read live from Robinhood Chain. Deposits, sealed orders, settlement and withdrawals are real transactions against an unaudited contract. Access will be subject to screening and jurisdiction eligibility.":
    "参考价格、发行方乘数、资产资格与保护状态均实时读取自 Robinhood Chain。存入、密封订单、结算与提取，都是针对未经审计合约的真实交易。使用权将取决于合规审查与司法辖区资格。",
  "LIVE VENUE": "实时场所",
  "Submit a sealed order": "提交密封订单",
  "Built and encrypted inside your vault, so the order never exists in plaintext outside it. No cookie is sent with it — nothing links this order to your wallet address in our logs.":
    "订单在你的金库内构建并加密，因此它的明文从不存在于金库之外。发送时不带 cookie——我们的日志中没有任何内容能把这笔订单与你的钱包地址关联起来。",
  Asset: "资产",
  Side: "方向",
  Sell: "卖出",
  "Raw units": "份额",
  "SHIELDED VAULT · LIVE": "屏蔽金库 · 实时",
  "Your private balance": "你的私密余额",
  "Your shielded balance is computed in your browser, from keys derived from a signature. Nothing here is sent to a server: the vault reads the public commitment set and works out which notes are yours locally, so no one — us included — learns which leaves you asked about.":
    "你的屏蔽余额在浏览器中计算，所用密钥由一个签名派生而来。这里没有任何内容会发送到服务器：金库读取公开的承诺值集合，在本地算出哪些票据属于你，因此没有任何人——包括我们——会知道你查询的是哪些叶子节点。",
  "Signing derives your viewing keys. It approves no transaction and moves no funds.":
    "签名用于派生你的查看密钥。它不批准任何交易，也不转移任何资金。",
  Vault: "金库",
  "A hash of your viewing key — it identifies the vault without being able to read it.":
    "这是你查看密钥的哈希值——它能标识该金库，却无法读取其中内容。",
  "Your notes": "你的票据",
  "Anonymity set": "匿名集合",
  "Lock vault": "锁定金库",
  WITHDRAW: "提取",
  Note: "票据",
  DEPOSIT: "存入",
  Solvency: "偿付能力",
  "Reading the chain…": "正在读取链上数据…",
  Method: "方式",
  "On-chain invariant, once deployed": "部署后即为链上不变量",
  "Verified on chain — not a ZK proof": "链上核验 —— 并非零知识证明",
  "Commitment tree": "承诺树",
  "Order disclosure": "订单披露",
  "Individual orders sealed": "单笔订单已密封",
  "Trade reporting": "成交报告",
  Window: "窗口",
  "The pool holds nothing yet. Every eligible asset owes nothing and holds nothing.":
    "资金池目前尚无持仓。每一项合格资产都既无负债，也无持有。",
  "YOUR ORDERS": "你的订单",
  "Open your vault to see what became of your orders.": "打开金库，查看你的订单最终如何。",
  "No orders from this browser yet. Submit a sealed order and its outcome appears here once the window settles.":
    "此浏览器尚无订单。提交一笔密封订单，窗口结算后结果就会显示在这里。",
  "No orders yet. Submit a sealed order and its outcome appears here once the window settles.":
    "尚无订单。提交一笔密封订单，窗口结算后结果就会显示在这里。",
  "Reading the venue…": "正在读取场所数据…",
  "Settled on chain ↗": "已在链上结算 ↗",
  Wallet: "钱包",
  "Install MetaMask": "安装 MetaMask",
  "Sign out": "退出登录",
  Disconnect: "断开连接",

  // Conditional labels
  "LIVE · TESTNET": "已上线 · 测试网",
  "RHC TESTNET": "RHC 测试网",
  "Check MetaMask…": "请查看 MetaMask…",
  "Retry connect": "重新连接",
  "Connect MetaMask": "连接 MetaMask",

  // Flagged dashboard features. Terminology follows the existing dictionary:
  // 参考价 for the reference, 份额 for raw units, 暗池 for the venue.
  "THIS SESSION": "本次会话",
  "YOUR POSITION": "你的持仓",

  // The auction clock. 撮合 for crossing, 密封 for sealing, matching the existing vocabulary.
  WINDOW: "窗口",
  EPOCH: "纪元",
  "SEALING IN": "距离密封",
  Ready: "开放",
  Sealed: "已密封",
  Crossing: "撮合中",
  Proof: "证明",
  Settled: "已结算",
  "The book is open. Orders arrive encrypted and nobody — us included — can read them.":
    "订单簿开放。订单以加密形式到达，任何人 —— 包括我们 —— 都无法读取。",
  "The book is frozen. Prices commit next, so the venue cannot see this book and then choose what it trades against.":
    "订单簿已冻结。价格随后才在链上确定，因此交易场所无法先看到这本订单簿再选择撮合的参考价。",
  "Matched size is the smaller side in full, split pro-rata. No fill rate is chosen by anyone.":
    "撮合量为较小一方的全部数量，按比例分配。成交比例不由任何人选择。",
  "One zero-knowledge proof for the whole batch, generated and verified on chain.":
    "整批交易只用一个零知识证明，生成后在链上验证。",
  "Nullifiers published, output notes spliced into the tree.":
    "作废标识已公布，输出票据已并入承诺树。",
  "order in this window": "笔订单在本窗口",
  "orders in this window": "笔订单在本窗口",
  Previous: "上一个",
  window: "窗口",
  "no counterparty": "无对手方",
  "BOOK CLOSED": "订单簿已截止",
  Quantity: "数量",
  Amount: "金额",
  MAX: "全部",
  "raw units": "原始单位",
  "Tell me when a window settles": "窗口结算时通知我",
  "Notifications are blocked for this site. Outcomes still appear here.":
    "本站的通知已被浏览器屏蔽。结果仍会显示在这里。",
  "Settled on chain": "已在链上结算",
  "PRIVACY, RIGHT NOW": "当前隐私状况",
  "CONTROLLED DISCLOSURE": "受控披露",
  "Vault open": "保险库已打开",
  "Test your recovery": "测试你的恢复能力",
  "Rebuild my records": "重建我的记录",
  "Your notes are found using records this browser keeps. The chain holds everything needed to rebuild those records — a deposit is a public transfer, so it knows the asset, the amount and who sent it, and your signature supplies the rest.":
    "你的票据是通过本浏览器保存的记录找到的。链上保存了重建这些记录所需的一切 —— 存入是一笔公开转账，因此链上知道资产、金额和发送方，其余部分由你的签名提供。",
  "Testing changes nothing. It runs the real recovery and reports what would have come back — which is worth knowing now rather than on the day a browser is cleared.":
    "测试不会改变任何数据。它会执行真实的恢复流程并告诉你能找回什么 —— 这件事值得现在就知道，而不是等到浏览器被清空的那天。",
  "locks in": "将于",
  "no automatic lock": "未设置自动锁定",
  "Lock after": "闲置多久后锁定",
  "Lock now": "立即锁定",
  Never: "永不",
  "Locking destroys the worker that holds your keys rather than hiding a balance — they are gone from this page until you sign again. The timer counts what you do, not what the page does: polling the venue does not keep it open.":
    "锁定会销毁持有你密钥的 worker，而不只是把余额藏起来 —— 在你再次签名之前，密钥已从本页面消失。计时只统计你的操作，而非页面自身的动作：轮询交易场所不会让它保持打开。",
  "Open your vault to grant an auditor a scoped view of one epoch.":
    "打开你的保险库，即可授予审计方对某一纪元的受限查看权限。",
  "Auditor's public key": "审计方公钥",
  Epoch: "纪元",
  "Seal this epoch to that auditor": "将该纪元密封给这位审计方",
  "Copy the sealed key": "复制密封密钥",
  Auditor: "审计方",
  "Someone not on the registry…": "不在注册表上的人…",
  "Record this grant on chain": "将该授权记录到链上",
  "Recording…": "正在记录…",
  "Recorded.": "已记录。",
  "See the grant on chain": "在链上查看该授权",
  "sealed.": "已密封。",
  "Reference price chart loading": "参考价图表加载中",
  "LOADING HISTORY…": "正在加载历史…",
  "HISTORY UNAVAILABLE": "暂无历史数据",
  "No anonymity": "无匿名性",
  Minimal: "极弱",
  Weak: "较弱",
  Moderate: "中等",
  Meaningful: "有实质意义",
  "notes that are not yours": "不属于你的票据",
  "What this is made of": "这是如何得出的",
  "Hide what this is made of": "收起说明",
  "Your deposit is public": "你的存入是公开的",
  Timing: "时间关联",
  "The operator sees a sealed book": "运营方可看到已密封的订单簿",
  "Nothing links an order to your wallet here": "这里没有任何东西把订单与你的钱包关联起来",
  Dismiss: "关闭",
  "Enter an amount.": "请输入金额。",
  "Enter an amount greater than zero.": "请输入大于零的金额。",
  "Amounts are digits and at most one decimal point.": "金额只能包含数字，且最多一个小数点。",
  "This asset has no fractional units.": "该资产不支持小数单位。",
  "s ago": " 秒前",
  "m ago": " 分钟前",
  "h ago": " 小时前",
  settled: "已结算",
  filled: "笔成交",
  "was voided — nothing crossed and no note was spent":
    "已作废 —— 没有任何撮合，也没有任何票据被花费",
  "failed — nothing crossed and no note was spent": "已失败 —— 没有任何撮合，也没有任何票据被花费",
  "Nothing was submitted, so there is nothing to seal — sealing an empty book pays gas to say nothing. The venue moves to the next window.":
    "本窗口没有任何订单，因此无需密封 —— 密封空订单簿只会白白消耗 gas。系统将进入下一个窗口。",
  "The book's time is up. The venue seals it on its next pass, within a minute.":
    "订单簿时间已到。系统将在下一轮处理中完成密封，通常在一分钟内。",
  "Reading the venue clock…": "正在读取交易场所时钟…",
  "No window is open. The venue opens the next one on its own.":
    "当前没有开放的窗口。系统会自动开启下一个。",
  "Robinhood Chain could not be reached to check which notes are already spent, so none are shown. Your notes are safe and nothing has been lost — this retries on its own every few seconds.":
    "无法连接 Robinhood Chain 来核对哪些票据已被花费，因此暂不显示任何票据。你的票据是安全的，没有任何损失 —— 系统会每隔几秒自动重试。",
};
