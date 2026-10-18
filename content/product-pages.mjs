/** Public product discovery content. Update reviewed dates only after an editorial review.
 * Competitor facts are limited to the cited primary sources, checked 2026-10-17.
 * Application routes are CTAs, not substitutes for these public, crawlable pages.
 */
export const REVIEWED = "2026-10-17";
const cta = (label, href) => ({ label, href });
const section = (heading, paragraphs, extra = {}) => ({
  heading,
  paragraphs,
  ...extra,
});
const faq = (question, answer) => ({ question, answer });

export const FEATURES = [
  {
    path: "/features/card-scanner",
    category: "Recognise",
    label: "Card scanner",
    title: "Pokémon Card Scanner & Scan Connect | Pokoin",
    description:
      "Identify Pokémon cards from a photo or phone camera. Pair your phone with Scan Connect to review cards and add them to your collection or seller inventory.",
    headline: "A Pokémon card scanner for the card in your hand.",
    intro:
      "Pokoin identifies trading cards from photos and a phone camera, then connects the match to its catalog page. Use a quick photo lookup for one card, or pair your phone with Scan Connect to work through a pile at your desktop.",
    answer:
      "Scan a card, confirm the printing, and choose its next step: explore the market, keep it in your collection, or prepare a listing.",
    visual: "scan",
    primary: cta("Identify a card from a photo", "/scan"),
    secondary: cta("Open Scan Connect", "/inventory/scan"),
    sections: [
      section(
        "Choose a scan that fits the job",
        [
          "For a single lookup, upload a photo on the card scanner page. If you are starting with the physical card, open the phone camera scanner. A match gives you a route into the catalog, where the card’s set, collector number, artwork, listings, and related printings help you check its identity.",
        ],
        {
          links: [
            cta("Open the phone camera scanner", "https://scan.pokoin.com/"),
          ],
        },
      ),
      section(
        "Use your phone as the camera and your desktop as the workspace",
        [
          "Scan Connect pairs a phone with your signed-in desktop scan desk using a QR code or pairing code. Recognised cards enter a queue you can review on the larger screen.",
          "Set the batch intent to collection or listing, then check each card’s printing, language, quantity, condition, and other relevant attributes. Review the queue before submitting it. Scanning a card is not the same as publishing a listing.",
        ],
      ),
      section("Keep the details in your hands", [
        "Recognition can suggest a catalog match; it cannot establish the physical condition of your copy. Similar artwork, foil treatments, and reprints deserve a second look. Compare the set and printed number before you save or list a card.",
        "Choose the appropriate game and catalog in the scanner. Marketplace coverage and recognition catalogs are different, so a game being available in the marketplace does not mean every printing can be recognised from a photo.",
      ]),
    ],
    faqs: [
      faq(
        "Can I scan Pokémon cards without installing an app?",
        "Yes. Pokoin’s photo lookup and phone camera scanner run in the browser. Scan Connect also uses a browser on your phone and desktop.",
      ),
      faq(
        "Does scanning automatically list my cards for sale?",
        "No. Review the scan queue and choose collection or listing intent before submitting. A quick photo lookup identifies a card; it does not publish a sale listing.",
      ),
    ],
    related: [
      "/learn/scan-cards-to-inventory",
      "/features/card-inventory",
      "/alternatives/dragon-shield",
    ],
  },
  {
    path: "/features/card-inventory",
    category: "Organise",
    label: "Seller inventory",
    title: "Trading Card Inventory Management for Sellers | Pokoin",
    description:
      "Manage trading card stock, quantities, conditions, languages, and storage locations in My Pokoin. Add cards by scanning or reviewing a stock spreadsheet.",
    headline: "Trading card inventory with a place for the details.",
    intro:
      "My Pokoin is a browser workspace for your trading card stock. Manage the copies you have listed, their quantities and attributes, and the locations that help you find the physical cards when an order arrives.",
    answer:
      "Bring cards in through Scan Connect or the spreadsheet workflow, review their catalog matches, and manage the resulting listings in My Pokoin.",
    visual: "inventory",
    primary: cta("Open My Pokoin", "/mypokoin"),
    secondary: cta("Prepare stock from a spreadsheet", "/mypokoin/spreadsheet"),
    sections: [
      section("Track copies, not just card names", [
        "Two copies of the same card may have different conditions, languages, foil treatments, quantities, or locations. Keep those details attached to the stock you are selling instead of treating a card name as a complete inventory record.",
        "Location pages help you work through the listings assigned to a particular box or binder. Use names that match your physical storage so your digital stock can lead you back to the card.",
      ]),
      section(
        "Start with the pile or the file",
        [
          "Scan Connect is useful when the cards are in front of you: pair your phone, scan into the desktop queue, and review the batch. The spreadsheet desk is useful when your stock is already in rows: upload a supported file or paste text, inspect the card preview, then confirm the import.",
          "A spreadsheet import is a listing workflow. Review the matches and quantities carefully before confirming; a personal collection and sale stock have different purposes.",
        ],
        {
          links: [
            cta("Scan cards into a reviewed batch", "/inventory/scan"),
            cta(
              "Read the spreadsheet walkthrough",
              "/learn/import-card-inventory",
            ),
          ],
        },
      ),
      section(
        "Keep the order workflow close",
        [
          "My Pokoin links your listings to sold history, buy history, and account settings. Export the live inventory as CSV when you need a copy of the current book.",
          "CardTrader and other connection options have their own setup and review flows. Connecting a service should be a deliberate action; do not assume that every external listing or edit is automatically synchronised.",
        ],
        {
          links: [
            cta("Export your current inventory", "/mypokoin/import"),
            cta("Review your account connections", "/profile"),
          ],
        },
      ),
      section(
        "Understand the marketplace you are listing on",
        [
          "Pokoin supports card payments via Stripe and PKN where accepted by the seller. Check payment and buyer-protection information before you begin selling. An inventory record or an asking price does not mean a buyer has purchased the card.",
        ],
        {
          links: [
            cta("Read buyer protection", "/protection"),
            cta("Explore the wallet", "/wallet"),
          ],
        },
      ),
    ],
    faqs: [
      faq(
        "Can I organise cards by storage location?",
        "Yes. My Pokoin supports stock locations and location-specific pages, so you can organise listings around the boxes or binders you use.",
      ),
      faq(
        "Can I bring in a stock spreadsheet?",
        "Yes. The spreadsheet desk accepts supported files and pasted rows, shows a preview, and asks you to confirm before listing. Inspect the recognised format and card matches first.",
      ),
    ],
    related: [
      "/features/collection-tracker",
      "/learn/import-card-inventory",
      "/alternatives/tcgplayer",
    ],
  },
  {
    path: "/features/collection-tracker",
    category: "Collect",
    label: "Collection & portfolio",
    title: "Pokémon Collection Tracker & Card Portfolio | Pokoin",
    description:
      "Keep your Pokémon collection together, review your card portfolio, and explore printings and sold history. Collect cards separately from the stock you list for sale.",
    headline: "Your Pokémon collection, with the bigger picture in view.",
    intro:
      "Pokoin brings a personal card collection, a portfolio overview, and a searchable marketplace into the same browser experience. Keep the cards you own organised while exploring the printings and market information behind them.",
    answer:
      "Use Collection for the cards you keep and My Pokoin listings for sale stock. The portfolio dashboard gives you an overview of your account and collection.",
    visual: "collection",
    primary: cta("Open your collection", "/mypokoin/collection"),
    secondary: cta("View your portfolio", "/dashboard"),
    sections: [
      section(
        "Give each printing its own place",
        [
          "A collection is more useful when it identifies the actual printing: the expansion, collector number, language, and artwork matter. Open the card desk to compare printings rather than relying on a name alone.",
          "Use Scan Connect with collection intent to review a pile before adding it to your collection. Collection intent records ownership without asking you to price the cards as sale stock.",
        ],
        {
          links: [
            cta("Start a collection scanning session", "/inventory/scan"),
          ],
        },
      ),
      section(
        "See your collection from more than one angle",
        [
          "The dashboard provides a portfolio overview and collection history, while individual card pages let you look into a particular printing. Browse sets to revisit an expansion, or follow an illustrator to find related artwork.",
          "Reference values, seller asking prices, and recorded sold prices answer different questions. A portfolio estimate is not a guaranteed sale price or an offer to buy the cards. Check condition, language, and printing when comparing market information.",
        ],
        {
          links: [
            cta("Explore card sets", "/marketplace/sets"),
            cta("Discover illustrators", "/marketplace/en/artists"),
          ],
        },
      ),
      section(
        "Use the same card context in a conversation",
        [
          "Poko can use the card page you are viewing as context, alongside your account’s collection, watchlist, and recent discoveries. Ask about a printing or its sold history, then open the relevant card page to inspect the details.",
          "You can collect without listing everything you own. When a card is ready to leave your collection, prepare the sale listing deliberately and check its physical attributes.",
        ],
        { links: [cta("Meet Poko", "/features/poko-assistant")] },
      ),
    ],
    faqs: [
      faq(
        "Is a collection the same as seller inventory?",
        "No. Collection records cards you own and keep. Seller inventory is the stock you have listed. Scan Connect offers separate collection and listing intents.",
      ),
      faq(
        "Does Pokoin have a portfolio dashboard?",
        "Yes. The signed-in dashboard provides a portfolio and collection overview. The public marketplace is available separately for browsing and researching cards.",
      ),
    ],
    related: [
      "/alternatives/collectr",
      "/features/card-scanner",
      "/features/poko-assistant",
    ],
  },
  {
    path: "/features/poko-assistant",
    category: "Understand",
    label: "Poko AI assistant",
    title: "Poko: AI Assistant for Pokémon Cards & Collections | Pokoin",
    description:
      "Ask Poko about Pokémon card printings, sold history, sets, and illustrators. Start from a card page and bring your collection context into the conversation.",
    headline: "Meet Poko, your AI card assistant.",
    intro:
      "Ask Poko about your cards with real market data behind the answer. Explore CardTrader asking prices, available TCGplayer aggregate quotes, printings and artists.",
    answer:
      "Start a Poko conversation from Messages or a card page. When you are viewing a card, that printing can become context for your question.",
    visual: "poko",
    primary: cta("Talk to Poko", "/messages/poko"),
    secondary: cta("Find a card to ask about", "/marketplace"),
    sections: [
      section("Ask about the card you are actually viewing", [
        "A name such as Charizard is not enough to identify a particular card. Set, number, rarity, and language can point to very different printings. Starting from a card page gives Poko a more useful starting point.",
        "Try questions such as “Which printing is this?”, “What has this card sold for?”, or “Show me more cards by this illustrator.” If a question could refer to several cards, clarify the printing before relying on the answer.",
      ]),
      section(
        "Connect card research with your collection",
        [
          "Signed-in conversations can use personal context such as your collection, inventory, watchlist, and recently viewed cards. That helps when a question is about what you already own or the card you were just exploring.",
          "Poko is available in the website’s Messages and chat dock. Account linking also supports Telegram and Discord conversations through the connection flow. Your public card research and private account context serve different purposes; your personal inventory is not a public article.",
        ],
        {
          links: [cta("Open your account and connection options", "/profile")],
        },
      ),
      section("Keep asks, sales, and estimates distinct", [
        "A seller’s asking price tells you what a copy is listed for. A recorded sold price describes an observed market event. A collection estimate combines information into a reference value. Ask which one an answer uses, and inspect the printing, date, condition, and language.",
        "Poko can help you explore information, but a reply should not replace checking the card or the source data. If market information is unavailable, do not treat a guessed number as a quote.",
      ]),
    ],
    faqs: [
      faq(
        "Is Poko a separate card-scanning app?",
        "No. Poko is the conversational assistant. The card scanner identifies cards from photos, and you can then explore the matched printing or ask Poko about it.",
      ),
      faq(
        "Can Poko use the card page I am on?",
        "Yes. The website includes the open card as conversation context, so a question about “this card” can refer to the printing you are viewing.",
      ),
    ],
    related: [
      "/features/collection-tracker",
      "/features/marketplace",
      "/features/card-scanner",
    ],
  },
  {
    path: "/features/cardrails-inventory",
    category: "Organise",
    label: "CardRails inventory",
    title: "CardRails Trading Card Inventory & Stock Management | Pokoin",
    description:
      "Scan cards, organise quantities and storage locations, and connect your Pokoin seller inventory with CardRails.",
    headline: "Every card. In its place.",
    intro:
      "CardRails is a dedicated workspace for trading card inventory. Scan cards, review the matches, and keep quantities, conditions and storage locations together.",
    answer:
      "Open CardRails to manage your stock. Connect your Pokoin account through the app’s connection flow to work with the cards you sell on Pokoin.",
    visual: "inventory",
    primary: cta("Open CardRails", "https://cardrails.vercel.app"),
    secondary: cta("Open My Pokoin", "/mypokoin"),
    sections: [
      section("From a scan to organised stock", [
        "Capture cards, review their printings and attributes, then add the batch to inventory. Keep quantities and physical shelf positions attached to the copies you own.",
      ]),
      section("Connect your Pokoin inventory", [
        "Start the Pokoin connection inside CardRails. Review the account and permissions before approving access. Connected inventory uses your Pokoin stock locations to help you find the physical cards.",
      ]),
    ],
    faqs: [
      faq(
        "How do I connect CardRails to Pokoin?",
        "Open CardRails and start its Pokoin connection flow. Sign in to the intended Pokoin account, review the requested access, and return to CardRails after approving.",
      ),
      faq(
        "Can I track where my cards are stored?",
        "Yes. CardRails tracks physical stock positions, and its Pokoin connection uses your Pokoin inventory locations.",
      ),
    ],
    related: [
      "/features/card-scanner",
      "/features/card-inventory",
      "/learn/scan-cards-to-inventory",
    ],
  },
  {
    path: "/features/marketplace",
    category: "Discover",
    label: "Card marketplace",
    title: "Trading Card Marketplace, Printings & Sold History | Pokoin",
    description:
      "Explore Pokémon and other trading card games on Pokoin. Browse sets, artists, printings, seller listings, and sold history, with card payments and seller-supported PKN checkout.",
    headline: "A trading card marketplace built around the card.",
    intro:
      "Explore cards with real market data: CardTrader listings, available TCGplayer price history, and Pokoin seller offers. Keep your research connected to your collection.",
    answer:
      "Find a card by name, set, artist, or printing. Compare the copy you want with seller listings and sold history before deciding what to collect or list.",
    visual: "marketplace",
    primary: cta("Explore the marketplace", "/marketplace"),
    secondary: cta("Browse sets and expansions", "/marketplace/sets"),
    sections: [
      section("Start with identity, then compare the market", [
        "A shared illustration does not make two printings interchangeable. Use the card page’s expansion, number, language, rarity, and related printings to narrow down the card you mean.",
        "Keep listed asking prices separate from recorded sold prices. Check date, condition, language, and finish before comparing two prices. A reference price does not guarantee that a copy is available at that amount.",
      ]),
      section(
        "Explore beyond a search result",
        [
          "Browse an expansion, follow an illustrator, or revisit cards on your watchlist. Pokémon catalog hubs organise cards by species, era, rarity, and print language, giving you different ways into the same collection of printings.",
          "Other supported trading card games have their own marketplace paths. Choose the game you are collecting rather than mixing unrelated catalog results.",
        ],
        {
          links: [
            cta("One Piece", "/one-piece/marketplace"),
            cta("Magic", "/magic/marketplace"),
            cta("Yu-Gi-Oh!", "/yugioh/marketplace"),
            cta("Lorcana", "/lorcana/marketplace"),
            cta("Riftbound", "/riftbound/marketplace"),
          ],
        },
      ),
      section(
        "Know how Pokoin checkout works",
        [
          "Pay by card through Stripe, or use PKN where the seller accepts it. Seller funds are released through the relevant delivery and buyer-protection process.",
          "Compare the actual seller, shipping terms, card attributes, and checkout requirements before purchasing. If you want to sell, review your inventory and listing details first.",
        ],
        {
          links: [
            cta("Read buyer protection", "/protection"),
            cta("Explore the PKN wallet", "/wallet"),
            cta("Prepare a listing", "/mypokoin"),
          ],
        },
      ),
    ],
    faqs: [
      faq(
        "Is Pokoin only for Pokémon?",
        "Pokémon has a dedicated catalog and research hubs. Pokoin also has separate marketplace paths for other games, including One Piece, Magic, Yu-Gi-Oh!, Lorcana, and Riftbound. Recognition coverage is a separate question from marketplace coverage.",
      ),
      faq(
        "What currency does Pokoin use?",
        "Card payments run through Stripe. PKN is also available where accepted by the seller. Review the final checkout and buyer-protection terms.",
      ),
    ],
    related: [
      "/alternatives/cardmarket",
      "/features/poko-assistant",
      "/features/card-inventory",
    ],
  },
].map((page) => ({ ...page, kind: "feature", reviewed: REVIEWED }));

export const ALTERNATIVES = [
  {
    path: "/alternatives/collectr",
    label: "Collectr",
    title: "Collectr Alternative for Scanning & Inventory | Pokoin",
    description:
      "Compare Pokoin and Collectr for card scanning, collection tracking, and seller workflows. Explore Pokoin’s browser tools, Scan Connect, and Poko assistant.",
    headline: "Looking for a Collectr alternative? Start with your workflow.",
    intro:
      "Explore Pokoin as a Collectr alternative with CardTrader and TCGplayer market data, card scanning, collection tracking, seller inventory and Poko in one browser workspace.",
    answer:
      "Consider Pokoin when your next step is reviewing a scan batch, organising stock, preparing listings, or asking Poko about a printing. Consider Collectr’s documented portfolio and mobile features when those are your priorities.",
    competitorSummary:
      "Collectr describes portfolio tracking, camera scanning, price history, trade analysis, and social features. It offers mobile apps and a web portfolio. Its PRO page lists additional scanning, export, and pricing-history features; check the current plan before choosing.",
    rows: [
      [
        "Getting started",
        "Mobile apps and a web portfolio.",
        "Browser pages for research, collection, inventory, and Poko.",
      ],
      [
        "Adding cards",
        "Camera scanning adds cards to a collection.",
        "Photo lookup or a reviewed phone-to-desktop Scan Connect batch.",
      ],
      [
        "Your next task",
        "Portfolio tracking, trade analysis, and social collecting.",
        "Collection, seller stock, spreadsheet listings, and card conversations.",
      ],
      [
        "Things to check",
        "Current free and PRO feature limits.",
        "Card payments via Stripe; PKN where accepted. No native app-store listing yet.",
      ],
    ],
    sections: [
      section("When Pokoin is a useful fit", [
        "Try Pokoin when a card scanner is the beginning of a stock workflow. Pair a phone with your desktop, inspect the recognised printings, set the relevant attributes, and decide whether the batch belongs in your collection or seller inventory.",
        "Poko adds a conversational route into the card catalog. Ask about the card you are viewing, explore an illustrator, or investigate sold history without losing the printing context.",
      ]),
      section("Try a small batch before changing your system", [
        "Start with a few cards you can verify by set and collector number. Use collection intent for the cards you keep; use listing intent only for sale stock you have reviewed.",
        "This is a workflow comparison, not a promise of a one-click Collectr migration. If you have an exported file, inspect its columns and Pokoin’s preview before using any stock import. Spreadsheet confirmation can create listings, so do not treat it as a personal-collection import.",
      ]),
    ],
    faqs: [
      faq(
        "Does Collectr also have scanning?",
        "Yes. Collectr’s official site describes camera scanning, and its PRO page explains its plan features. Pokoin’s alternative combines photo lookup and Scan Connect with collection and seller tools.",
      ),
      faq(
        "Can I move my whole Collectr portfolio in one click?",
        "A dedicated one-click Collectr migration is not promised here. Review any export format and catalog matches first. Pokoin’s stock spreadsheet workflow prepares listings, not a silent copy of a personal portfolio.",
      ),
    ],
    sources: [
      cta(
        "Collectr: official product overview",
        "https://www.getcollectr.com/",
      ),
      cta("Collectr: PRO features", "https://www.getcollectr.com/pro"),
      cta("Collectr: web portfolio", "https://app.getcollectr.com/portfolio"),
    ],
    related: [
      "/features/pokemon-card-price-checker",
      "/features/collection-tracker",
      "/features/card-scanner",
      "/features/card-inventory",
    ],
  },
  {
    path: "/alternatives/dragon-shield",
    label: "Dragon Shield",
    title: "Dragon Shield Card Scanner Alternative | Pokoin",
    description:
      "Compare Pokoin with Dragon Shield’s Poké TCG Card Manager. Explore browser scanning, reviewed scan batches, seller inventory, and the Poko card assistant.",
    headline:
      "A Dragon Shield scanner alternative for your next card workflow.",
    intro:
      "Scan a card, then explore CardTrader and TCGplayer market data. Pokoin connects browser scanning to collection tracking, seller inventory and Poko.",
    answer:
      "Use Pokoin to review a phone scan queue at your desktop, choose collection or listing intent, and continue researching the matched printing in the marketplace.",
    competitorSummary:
      "Dragon Shield’s developer-published Poké TCG app listing describes collection folders, price tracking, exports, deck tools, and trade features. Its Poké TCG web manager is also available. Review the official listing and manager for the current experience.",
    rows: [
      [
        "Where you work",
        "Poké TCG app and web manager.",
        "Photo lookup, phone camera, and desktop tools in the browser.",
      ],
      [
        "Keeping cards",
        "Collection folders and value tracking are described in the app listing.",
        "Collection intent records owned cards separately from sale stock.",
      ],
      [
        "Working through stock",
        "Check the current app and export workflow.",
        "Review a Scan Connect queue, then confirm collection or listings.",
      ],
      [
        "Researching a printing",
        "The app listing describes pricing and card-management tools.",
        "Open the card desk or ask Poko with the card as context.",
      ],
    ],
    sections: [
      section("Choose a workflow around the physical pile", [
        "For a quick identity check, use Pokoin’s photo lookup. For a session with a larger pile, open Scan Connect on your desktop, pair your phone, and use the phone as the camera.",
        "The queue is a review step. Check the suggested printing and the physical copy’s condition, language, finish, and quantity before deciding where it belongs. A recognition result is not an automatic condition grade.",
      ]),
      section("Continue from recognition into research", [
        "After finding a card, explore the expansion, artwork versions, seller listings, and sold history. Poko gives you another way to ask about the same printing or discover related cards by an illustrator.",
        "Dragon Shield’s documented deck and trade tools may be relevant if those are your main tasks. Pokoin’s pages here focus on identification, collecting, inventory, and marketplace research; they do not claim equivalent versions of every Dragon Shield feature.",
      ]),
    ],
    faqs: [
      faq(
        "Can I use Pokoin without installing a scanner app?",
        "Yes. Photo identification, the phone camera scanner, and Scan Connect use browser pages. Sign in for the inventory and collection workflow.",
      ),
      faq(
        "Will Pokoin grade the condition of a scanned card?",
        "No automatic condition grading is promised. Recognition helps identify a catalog printing; you must inspect the physical copy and review its attributes.",
      ),
    ],
    sources: [
      cta(
        "Dragon Shield: official Poké TCG web manager",
        "https://poketcg.dragonshield.com/",
      ),
      cta(
        "Dragon Shield: developer-published Poké TCG app listing",
        "https://apps.apple.com/gb/app/pok%C3%A9-tcg-scanner-dragon-shield/id1199495742",
      ),
    ],
    related: [
      "/features/pokemon-card-price-checker",
      "/features/card-scanner",
      "/learn/scan-cards-to-inventory",
      "/features/poko-assistant",
    ],
  },
  {
    path: "/alternatives/tcgplayer",
    label: "TCGplayer",
    title: "TCGplayer Scanner & Inventory Alternative | Pokoin",
    description:
      "Compare Pokoin’s browser scanner and inventory workflow with TCGplayer’s app and Scan & Identify tools. Review the workflow, marketplace, and payment differences.",
    headline: "A TCGplayer alternative for scanning, stock, and card research.",
    intro:
      "Bring available TCGplayer price data together with CardTrader listings, a browser scanner, collection tools and Poko. Pokoin offers a separate marketplace and seller workflow.",
    answer:
      "Pokoin connects a phone scan queue to collection or listing intent. TCGplayer also has mobile scanning and desktop seller tools; phone-to-desktop scanning is not exclusive to Pokoin.",
    competitorSummary:
      "TCGplayer’s mobile-app page describes scanning and organising cards for its Seller Portal. Its Scan & Identify documentation describes image-based identification, live scanning options, review, and publishing to inventory. Tool access and eligibility should be checked in TCGplayer’s current documentation.",
    rows: [
      [
        "Scanning",
        "Mobile app plus documented Scan & Identify seller tools.",
        "Photo lookup, phone camera, and Scan Connect.",
      ],
      [
        "Reviewing stock",
        "Scan & Identify includes review and inventory publishing.",
        "Check a batch and choose collection or listing intent.",
      ],
      [
        "Existing files",
        "The mobile scanning workflow supports inventory exports.",
        "The spreadsheet desk previews supported stock files and pasted rows.",
      ],
      [
        "Marketplace",
        "Listings and seller operations belong to TCGplayer’s platform.",
        "Card payments via Stripe, or PKN where the seller accepts it.",
      ],
    ],
    sections: [
      section("Compare the full stock journey", [
        "Test identification, printing correction, condition entry, quantity, storage location, and the point at which a row becomes a listing. Those steps affect your daily stock workflow more than a scanner’s marketing headline.",
        "In Pokoin, Scan Connect lets you choose a collection or listing batch. The spreadsheet desk provides another route when your stock is already in a file. Review the recognised format and card matches before confirming.",
      ]),
      section("Know where your listings will live", [
        "Pokoin is not a different front end for the TCGplayer Seller Portal. Preparing a Pokoin listing does not mean it has been published to TCGplayer.",
        "Keep an export of your source stock, check quantities before importing, and use the relevant connection flow when an external service is involved. Pokoin supports Stripe card payments and seller-supported PKN payments; review the relevant settlement requirements.",
      ]),
      section("Add a conversational research step", [
        "Open a matched printing to examine listings and sold history, or ask Poko about the card, expansion, or illustrator. The public marketplace is available for research before you decide to list stock.",
      ]),
    ],
    faqs: [
      faq(
        "Does TCGplayer already support desktop scanning workflows?",
        "Yes. TCGplayer documents Scan & Identify and live scanning options alongside its mobile app. This comparison does not claim that Pokoin is the only phone-to-desktop option.",
      ),
      faq(
        "Does a Pokoin spreadsheet import publish to TCGplayer?",
        "No such behaviour is promised. The Pokoin spreadsheet desk is a Pokoin listing workflow. External marketplace operations need their own supported setup and explicit review.",
      ),
    ],
    sources: [
      cta(
        "TCGplayer: official mobile app overview",
        "https://seller.tcgplayer.com/mobile-app",
      ),
      cta(
        "TCGplayer: Scan & Identify workflow",
        "https://help.tcgplayer.com/hc/en-us/articles/27303403772823-How-To-Use-Scan-Identify",
      ),
    ],
    related: [
      "/features/pokemon-card-price-checker",
      "/features/card-inventory",
      "/learn/import-card-inventory",
      "/features/marketplace",
    ],
  },
  {
    path: "/alternatives/cardmarket",
    label: "Cardmarket",
    title: "Cardmarket Alternative for Collectors & Sellers | Pokoin",
    description:
      "Explore Pokoin as a Cardmarket alternative for card discovery, scanning, inventory, and Poko. Compare the workflow and understand Pokoin’s card and PKN payment options.",
    headline:
      "Considering a Cardmarket alternative? Explore the card workflow.",
    intro:
      "Research cards with CardTrader and TCGplayer market data, then scan, collect or sell on Pokoin. Compare the seller offers and payment options that fit your next card.",
    answer:
      "Pokoin combines printing research with collection and seller workflows. It supports card payments through Stripe and PKN where sellers accept it. Compare the payment and protection terms on each marketplace.",
    competitorSummary:
      "Cardmarket’s official new-user guide describes buying from other users, comparing seller offers and attributes, and confirming shipment arrival. It explains its payment flow and Trustee Service. Read its current terms for the details of an actual purchase.",
    rows: [
      [
        "Buying cards",
        "Peer-to-peer seller offers with card attributes and filters.",
        "Seller listings on a specific catalog printing.",
      ],
      [
        "Checkout",
        "The official guide explains account funding and payment methods.",
        "Card payments via Stripe, or PKN where accepted by the seller.",
      ],
      [
        "Protection",
        "The guide describes the Trustee Service and its conditions.",
        "Pokoin’s separate buyer-protection policy governs its escrow process.",
      ],
      [
        "Beyond a purchase",
        "Review the current Cardmarket tools for your task.",
        "Scanner, collection, portfolio, inventory, and Poko in one browser experience.",
      ],
    ],
    sections: [
      section("Choose the right printing before the right offer", [
        "Set, language, condition, finish, and collector number can change what a card means to you and how two offers compare. In Pokoin, start from a card desk and inspect related printings before making a purchase decision.",
        "Browse sets or illustrators if you are still discovering what you want. Poko can help you investigate a card, while the scanner gives you a starting point when you already have a physical copy.",
      ]),
      section(
        "Understand the settlement difference",
        [
          "Pokoin releases seller funds through its delivery and buyer-protection process. Card payments use Stripe Connect; PKN is available where accepted. Read the protection policy before transacting.",
          "Neither this comparison nor a catalog reference price promises that a particular card is available, that another marketplace has the same offer, or that protection terms are identical. Check the actual seller, shipping details, and current policy.",
        ],
        {
          links: [
            cta("Read Pokoin buyer protection", "/protection"),
            cta("Explore the PKN wallet", "/wallet"),
          ],
        },
      ),
      section("Evaluate selling with a small, reviewed batch", [
        "If you are exploring Pokoin for sale stock, try a few cards in Scan Connect or the spreadsheet preview. Confirm the printing and physical attributes, then review the listings in My Pokoin.",
        "An external marketplace stock file needs format and quantity checks. Importing a file does not automatically synchronise every later edit with its original marketplace.",
      ]),
    ],
    faqs: [
      faq(
        "Is Pokoin checkout the same as Cardmarket checkout?",
        "No. Pokoin supports Stripe card payments and PKN where sellers accept it. Cardmarket documents its own funding, payment, and Trustee Service rules. Review the current terms on the platform where you buy.",
      ),
      faq(
        "Can I research cards before buying PKN?",
        "You can browse Pokoin’s public marketplace and catalog pages before using checkout. Sign-in and settlement requirements apply to the relevant account actions.",
      ),
    ],
    sources: [
      cta(
        "Cardmarket: official new-user guide",
        "https://help.cardmarket.com/en/new-user-guide",
      ),
    ],
    related: [
      "/features/pokemon-card-price-checker",
      "/features/marketplace",
      "/features/card-scanner",
      "/features/card-inventory",
    ],
  },
].map((page) => ({
  ...page,
  kind: "comparison",
  category: "Compare your options",
  reviewed: REVIEWED,
  visual: "compare",
  primary: cta("Explore Pokoin’s tools", "/features"),
  secondary: cta("Try a card lookup", "/scan"),
}));

export const GUIDES = [
  {
    path: "/learn/scan-cards-to-inventory",
    label: "Scan cards into a collection or inventory",
    category: "A practical walkthrough",
    title: "How to Scan Pokémon Cards into a Collection or Inventory | Pokoin",
    description:
      "Use your phone and Scan Connect to review Pokémon cards at your desktop, check printings and conditions, and submit a collection or listing batch.",
    headline: "How to turn a pile of Pokémon cards into a reviewed batch.",
    intro:
      "Use Scan Connect when you want to identify physical cards with your phone and review the results on a desktop before saving them. Start with a small pile, confirm the catalog matches, and decide whether you are recording a collection or creating sale stock.",
    answer:
      "You need a signed-in desktop scan desk, a phone browser with camera access, and the cards you want to check. For one photo rather than a batch, use the photo scanner instead.",
    visual: "scan",
    primary: cta("Start Scan Connect", "/inventory/scan"),
    secondary: cta("Identify one photo instead", "/scan"),
    sections: [
      section("1. Decide what the batch is for", [
        "Open Scan Connect on your desktop and choose collection or listing intent. Collection intent is for cards you own and want to keep. Listing intent is for sale stock. Choose the game and catalog that fit the cards.",
      ]),
      section("2. Pair your phone", [
        "Use the scan desk’s QR code or pairing code to connect your phone. Follow the camera-permission prompt in your phone browser. Keep the phone on the scanning page while the desktop holds the review queue.",
        "If a pairing code expires or the session disconnects, use the scan desk’s reconnect flow rather than sharing the pairing link publicly.",
      ]),
      section("3. Scan a small group", [
        "Place one card clearly in view and check that the scanner can see its face. Avoid glare across the artwork or printed number. Let recognised cards enter the desktop queue, then pause to review a few before continuing.",
      ]),
      section("4. Check the printing and the physical copy", [
        "Compare the name, expansion, printed collector number, and artwork. Check language and foil or other relevant attributes. Set the condition yourself after inspecting the physical copy; recognition is not condition grading.",
        "Check quantities and duplicate rows. If two cards look alike, make sure you are recording the same printing before merging or increasing a quantity.",
      ]),
      section(
        "5. Confirm the right destination",
        [
          "Review the complete batch before submitting. Collection intent adds ownership without an asking price. For listings, check the price and required stock details before confirming.",
          "Open your collection or My Pokoin afterwards and verify a few rows against the physical pile. Use storage locations that you can recognise when you need to retrieve a card.",
        ],
        {
          links: [
            cta("View your collection", "/mypokoin/collection"),
            cta("Review seller inventory", "/mypokoin"),
          ],
        },
      ),
      section("When a scan needs another look", [
        "If recognition is uncertain, compare the printed details and search the catalog manually. Reprints and similar artwork can lead to different catalog entries. Keep uncertain cards aside until you have verified the printing rather than saving the first suggestion.",
      ]),
    ],
    faqs: [
      faq(
        "Should I scan my whole collection before checking the results?",
        "Start with a small group. Verify the printing, condition, language, finish, and quantity before working through a larger batch.",
      ),
      faq(
        "Should I choose collection or listing intent?",
        "Choose collection for ownership without an asking price. Choose listing only for stock you intend to offer for sale after reviewing the required attributes and price.",
      ),
    ],
    related: [
      "/features/card-scanner",
      "/features/collection-tracker",
      "/features/card-inventory",
    ],
  },
  {
    path: "/learn/import-card-inventory",
    label: "Bring stock from a spreadsheet",
    category: "A practical walkthrough",
    title: "How to Import Trading Card Stock from a Spreadsheet | Pokoin",
    description:
      "Upload or paste a stock spreadsheet, review card matches, quantities, and locations, then confirm Pokoin listings. Learn what to check before importing.",
    headline: "From stock spreadsheet to reviewed Pokoin listings.",
    intro:
      "Pokoin’s spreadsheet desk lets sellers upload a supported stock file or paste rows, inspect the recognised format and cards, and confirm the listing import. Use it for stock you intend to sell, not as an unreviewed personal-collection migration.",
    answer:
      "Open Sell via spreadsheet, provide your file or pasted rows, review the preview and quantities, then confirm only when the stock and catalog matches are correct.",
    visual: "inventory",
    primary: cta("Open the spreadsheet desk", "/mypokoin/spreadsheet"),
    secondary: cta("Read about seller inventory", "/features/card-inventory"),
    sections: [
      section("1. Keep a copy of your source file", [
        "Save an unchanged copy before editing. Separate stock for sale from a personal portfolio export. The name of a card alone is not a reliable printing identifier, so keep set, collector number, and source identifiers when available.",
      ]),
      section("2. Upload a supported file or paste rows", [
        "Open the signed-in spreadsheet desk. Upload a file type accepted by the page or paste your stock text. The page shows the format it recognised and a preview of the cards.",
        "The parser recognises several stock-export shapes, including CardTrader, Cardmarket, TCGplayer, and Power Tools, plus custom columns it can match. That does not mean every export from those products is compatible. Inspect the actual preview.",
      ]),
      section("3. Review identity and quantity", [
        "Check names, sets, collector numbers, languages, conditions, quantities, and locations against the source. Look for missing rows, ambiguous printings, and a quantity that may already exist in your current inventory.",
        "An existing listing and a newly imported row can represent the same physical card. Resolve duplicates before confirming rather than assuming the import will understand the history of your stock.",
      ]),
      section("4. Check any CardTrader intent", [
        "When the preview detects CardTrader links, the desk asks whether you want to link existing cards or import stock. Read that choice carefully. Linking or importing stock that already exists on both sides can create duplicates.",
        "Do not assume that reviewing a file authorises every future sync. Use the supported account and integration flow for ongoing external-marketplace work.",
      ]),
      section(
        "5. Confirm, then inspect the result",
        [
          "Nothing is listed until you confirm in the spreadsheet desk. After confirmation, check the result and import status, then inspect the affected listings in My Pokoin.",
          "Card checkout supports Stripe and seller-accepted PKN. Verify the amount and the physical attributes before treating the new listings as ready. Export the live inventory when you need a record of the resulting stock.",
        ],
        {
          links: [
            cta("Review My Pokoin listings", "/mypokoin"),
            cta("Export the current stock", "/mypokoin/import"),
          ],
        },
      ),
    ],
    faqs: [
      faq(
        "Does uploading a spreadsheet immediately list cards?",
        "The desk first shows a preview. You must confirm before the listing import runs. Review the format, matches, quantities, and any integration choice before confirming.",
      ),
      faq(
        "Can I use this to copy a personal collection without selling it?",
        "This page describes the stock listing workflow. For ownership without sale listings, use the collection tools and collection intent in Scan Connect instead.",
      ),
    ],
    related: [
      "/features/card-inventory",
      "/alternatives/tcgplayer",
      "/features/collection-tracker",
    ],
  },
].map((page) => ({ ...page, kind: "guide", reviewed: REVIEWED }));

FEATURES.push({
  path: "/features/seller-fees",
  kind: "fees",
  category: "Keep more of each card sale",
  label: "Seller fees",
  reviewed: REVIEWED,
  title:
    "Trading Card Selling Fees: Stripe Costs, No Pokoin Seller Cut | Pokoin",
  description:
    "Pokoin adds a 3% buyer markup. Sellers pay their allocated actual Stripe processing and attributable Connect costs, with no Pokoin marketplace seller commission.",
  headline: "3% buyer markup. No Pokoin seller commission.",
  intro:
    "Pokoin adds 3% to the buyer’s card subtotal before payment. The seller’s card price is not reduced by that markup. Sellers bear their share of actual Stripe processing and attributable Connect costs.",
  answer:
    "For €100 of cards, the buyer pays €103 before shipping and optional cover. Seller proceeds start from €100 plus their shipping, less their share of actual Stripe processing and attributable Connect costs.",
  visual: "inventory",
  primary: cta("Open seller inventory", "/mypokoin"),
  secondary: cta("Prepare your first listings", "/mypokoin/spreadsheet"),
  tableHeading: "Compare the published base selling rates",
  tableLabel: "Published marketplace commission rates",
  tableHeaders: [
    "Marketplace or plan",
    "Base selling commission",
    "Scope and additional costs",
  ],
  rows: [
    [
      "Pokoin",
      "0% Pokoin marketplace seller commission. A 3% markup is added for the buyer.",
      "Seller bears actual allocated Stripe processing and attributable Connect costs. The single payment’s fixed fee is allocated once across sellers, not charged in full to each seller.",
    ],
    [
      "Cardmarket",
      "5% selling fee in its published fee table.",
      "Minimums, rounding, caps, and payment-method conditions affect the final cost. Check the current table for your account and market.",
    ],
    [
      "CardTrader EU direct sales",
      "5.0% for qualifying older accounts; 5.3% for accounts from March 2026.",
      "Minimum 1 cent per item. VAT is added where applicable. Zero, 1-Day Ready, and non-EU seller rates differ.",
    ],
    [
      "TCGplayer standard Marketplace Seller, Levels 1–4",
      "10.75% marketplace commission.",
      "Commission capped at $75 per product, plus 2.5% + $0.30 transaction fee. The transaction basis includes items, shipping, and tax; other programs and international sales differ.",
    ],
  ],
  sections: [
    section(
      "Choose how you want to sell",
      [
        "Self-service marketplace: 3% buyer markup, with no Pokoin seller commission. Managed selling: send cards to Pokoin and receive real-money proceeds after sale, with 15.5% commission. Immediate credit: exchange cards for 90% of market value in PKN, at least 1 PKN per card.",
      ],
      {
        links: [
          cta("Trade cards for PKN", "/features/trade-cards-for-pkn"),
          cta("Managed selling for real money", "/features/managed-selling"),
        ],
      },
    ),
    section("Buyer markup and Stripe costs are separate", [
      "Pokoin’s 3% markup is paid by the buyer. Seller proceeds are their full card subtotal plus shipping, less their allocated payment costs and any refunds. No 3% Pokoin fee is deducted from the seller’s card price.",
      "One Stripe transaction covers the whole cart. Its actual processing cost is allocated proportionally to seller item-plus-shipping amounts, with cent rounding that preserves the exact total. Separately billed Connect costs need verified attribution; they are not guessed or charged once per item.",
    ]),
    section(
      "A clear commission is a useful starting point",
      [
        "The 3% rate is a buyer markup, not a seller commission or an all-in payment cost. Stripe rates vary by card, currency and agreement. Compare the actual payment costs when choosing where to sell.",
        "An asking price is not a completed sale. Use a small, reviewed batch to check printings, quantities, locations, and prices before you publish more stock.",
      ],
      {
        links: [
          cta("Explore seller inventory", "/features/card-inventory"),
          cta("Review the wallet", "/wallet"),
        ],
      },
    ),
    section("Why this page compares named plans", [
      "The plans above have different fee bases, caps, minimums, rounding, tax treatment, payment methods, and services. A smaller headline percentage does not establish the lowest total cost for every card, order, seller, or country.",
      "In particular, a capped commission can produce a lower effective percentage on a high-value item. Fulfilment programs, local pickup, promotions, and direct trades also differ. Compare an actual order under the plan you use.",
    ]),
    section(
      "Make the rest of the selling workflow count",
      [
        "Pokoin’s scanner, reviewed Scan Connect batches, stock spreadsheet, storage locations, and Poko assistant help with the work around a listing. Choose the workflow that makes it easier to identify and retrieve the correct physical card.",
        "Keep collection ownership separate from stock you intend to sell. Read buyer protection and confirm the order’s shipping and payment details before completing a transaction.",
      ],
      {
        links: [
          cta("Start a scan batch", "/inventory/scan"),
          cta("Read buyer protection", "/protection"),
        ],
      },
    ),
  ],
  faqs: [
    faq(
      "Does the seller pay a 3% Pokoin commission as well as Stripe?",
      "No. The 3% markup is paid by the buyer. The seller bears actual allocated Stripe processing and any verified attributable Connect costs, plus applicable refunds or adjustments.",
    ),
    faq(
      "Who pays the 3% Pokoin markup?",
      "The buyer pays a 3% markup on the card item subtotal before Stripe payment. It is not deducted from the seller’s card price.",
    ),
    faq(
      "Does zero Pokoin seller commission mean selling has no costs?",
      "No. Stripe processing, attributable Connect costs, taxes, shipping and other applicable costs remain. Compare the actual order; caps, minimums and seller programs can change the result.",
    ),
  ],
  sources: [
    cta(
      "Stripe: separate charges and transfers",
      "https://docs.stripe.com/connect/separate-charges-and-transfers",
    ),
    cta(
      "Cardmarket: official selling fee table",
      "https://www.cardmarket.com/en/Pokemon/Policies/Fees",
    ),
    cta(
      "CardTrader: payments, fees, and refunds",
      "https://static.cardtrader.com/en/pages/payments-fees-and-refunds",
    ),
    cta(
      "TCGplayer: official marketplace fee table",
      "https://help.tcgplayer.com/hc/en-us/articles/201357836-TCGplayer-Fees",
    ),
  ],
  related: [
    "/features/card-inventory",
    "/learn/import-card-inventory",
    "/alternatives/cardmarket",
  ],
});

FEATURES.push({
  path: "/features/pokemon-card-price-checker",
  category: "Check card prices",
  label: "Pokémon card price checker",
  reviewed: REVIEWED,
  title: "Pokémon Card Price Checker & Value Research | Pokoin",
  description:
    "Check Pokémon card values with CardTrader listings and TCGplayer price data. Compare the printing, available history and source before buying or selling.",
  headline: "What is your Pokémon card worth?",
  intro:
    "Real market data from CardTrader and TCGplayer. Match your printing, compare available price history, and make your next move.",
  answer:
    "A useful value check matches the set, collector number, language, finish and condition. An asking price is an offer; it is not proof of a completed sale.",
  visual: "marketplace",
  primary: cta("Look up a Pokémon card", "/marketplace"),
  secondary: cta("Identify it from a photo", "/scan"),
  sections: [
    section("Real prices. Named sources.", [
      "CardTrader supplies observed seller listings and dated lowest asking prices. Poko and the inventory price-check tools also use available TCGplayer aggregate market-price history for matched printings and product subtypes.",
      "Source, observation date and currency matter: CardTrader asks are listed prices, while TCGplayer aggregate quotes are in USD and do not identify the condition or language of an individual sale. Coverage varies by printing. Inferred listing changes and completed Pokoin sales are labelled separately.",
    ]),
    section(
      "Match the printing",
      [
        "Search by card name and set, or start with a photo scan. Check the printed collector number, language and finish on the card page.",
      ],
      { links: [cta("Browse Pokémon sets", "/marketplace/sets")] },
    ),
    section("Read the price in context", [
      "Compare live seller listings with the available history for the same printing and attributes. Check dates and source labels: listed prices, inferred listing changes and completed Pokoin sales are different signals. Sparse data is not a guaranteed valuation.",
    ]),
    section(
      "Choose your next move",
      [
        "Keep the card in your collection, organise seller inventory, or prepare a listing at a price you choose.",
      ],
      {
        links: [
          cta("Track your collection", "/mypokoin/collection"),
          cta("Compare selling fees", "/features/seller-fees"),
        ],
      },
    ),
  ],
  faqs: [
    faq(
      "Can I check a Pokémon card’s value from a photo?",
      "Start with Pokoin’s card scanner, confirm the suggested printing, then open its marketplace page to compare prices. A photo match does not grade condition.",
    ),
    faq(
      "Is the displayed price what my card will sell for?",
      "No. Your copy’s condition, language, finish and demand affect the result. Asking prices and reference data do not guarantee a buyer or a sale price.",
    ),
  ],
  related: [
    "/features/card-scanner",
    "/features/collection-tracker",
    "/features/seller-fees",
  ],
});

// Owner-confirmed service terms (17 October 2026). Intake is coordinated by Contact;
// these pages do not claim the marketplace checkout automates receipt or credit issuance.
FEATURES.push({
  path: "/features/trade-cards-for-pkn",
  category: "Send cards · Get PKN",
  label: "Trade cards for PKN",
  reviewed: REVIEWED,
  title: "Trade Pokémon Cards for PKN Credit: 90% Market Value | Pokoin",
  description:
    "Send cards to Pokoin and choose immediate PKN credit at 90% of market value, with at least 1 PKN per card. Use PKN towards other cards where accepted.",
  headline: "Your cards. Your next collection.",
  intro:
    "Send your cards to Pokoin. Choose PKN credit at 90% of market value, with at least 1 PKN per card.",
  answer:
    "This option pays PKN credit for your next cards. Choose managed selling instead if you want real money after a sale.",
  visual: "credit",
  primary: cta("Arrange a card trade-in", "/contact"),
  secondary: cta("Prefer real money?", "/features/managed-selling"),
  sections: [
    section("Send cards. Get PKN. Collect again.", [
      "Contact Pokoin to arrange sending your cards and confirm the market valuation. The credit option gives you 90% of market value in PKN, with a guaranteed minimum of 1 PKN per card.",
      "The immediate-credit option lets you receive PKN without waiting for your cards to resell. Coordinate receipt and credit issuance with Pokoin; uploading a photo does not issue tokens.",
    ]),
    section(
      "Put your credit towards other cards",
      [
        "Browse the marketplace for your next cards. PKN is available as a payment option where the seller accepts it; review the final checkout before buying.",
      ],
      { links: [cta("Explore cards", "/marketplace")] },
    ),
    section(
      "Want a real-money sale instead?",
      [
        "With managed selling, you send the cards and Pokoin handles the sale. You receive real-money proceeds after the cards sell, less the managed-selling commission.",
      ],
      { links: [cta("See managed selling", "/features/managed-selling")] },
    ),
  ],
  faqs: [
    faq(
      "Is the 90% paid in cash?",
      "No. The immediate credit is paid in PKN. Managed selling is the real-money option.",
    ),
    faq(
      "Do I have to wait for a buyer to get PKN credit?",
      "The immediate-credit option does not require a resale first. Contact Pokoin to arrange card receipt, valuation and credit issuance.",
    ),
  ],
  related: [
    "/features/managed-selling",
    "/features/card-scanner",
    "/features/seller-fees",
  ],
});
FEATURES.push({
  path: "/features/managed-selling",
  category: "Send cards · Get real money",
  label: "Managed card selling",
  reviewed: REVIEWED,
  title: "Managed Pokémon Card Selling: 15.5% Commission | Pokoin",
  description:
    "Send your trading cards to Pokoin and let us sell them for you. Receive real-money proceeds after sale, with a 15.5% managed-selling commission.",
  headline: "We sell your cards. You get paid.",
  intro:
    "Send your cards to Pokoin. We handle the sale; you receive real-money proceeds when they sell. Managed-selling commission: 15.5%.",
  answer:
    "Managed selling pays real money after sale. It is separate from the 90% market-value PKN credit option and the 3% self-service buyer markup.",
  visual: "managed",
  primary: cta("Arrange managed selling", "/contact"),
  secondary: cta(
    "Prefer immediate PKN credit?",
    "/features/trade-cards-for-pkn",
  ),
  sections: [
    section("Send once. Let Pokoin sell.", [
      "Contact Pokoin to arrange sending your cards and agree the sale details. Pokoin handles selling the cards for you, and your proceeds are paid in real money after a sale. Sale timing and final price depend on buyers.",
    ]),
    section("15.5% managed-selling commission", [
      "The managed-selling fee is 15.5% of the card sale price. On a €100 sale, that leaves €84.50 before any separately agreed costs, taxes or adjustments. Confirm the intake and payout terms before sending cards.",
      "CardTrader’s published 1-Day Ready rate is 16.5%, with a minimum 1-cent fee and VAT added under its fee policy. Pokoin’s 15.5% base rate is one percentage point lower. This compares base commissions, not every possible cost.",
    ]),
    section(
      "Three ways to move your cards on",
      [
        "Sell yourself on Pokoin with a 3% buyer markup and no Pokoin seller commission. Send cards for immediate PKN credit at 90% of market value, at least 1 PKN per card. Or choose managed selling for real money after sale at 15.5% commission.",
      ],
      {
        links: [
          cta("Compare the selling options", "/features/seller-fees"),
          cta("Trade cards for PKN", "/features/trade-cards-for-pkn"),
        ],
      },
    ),
  ],
  faqs: [
    faq(
      "Are managed-sale proceeds paid in PKN?",
      "No. Managed sales pay real money. The immediate 90% credit option pays PKN.",
    ),
    faq(
      "Is managed selling the same as the CardTrader 1-DR tab?",
      "No. Pokoin’s CardTrader 1-DR tab displays linked CardTrader warehouse stock and sales. Pokoin managed selling is arranged directly with Pokoin.",
    ),
  ],
  sources: [
    cta(
      "CardTrader: published selling fees",
      "https://static.cardtrader.com/en/pages/payments-fees-and-refunds",
    ),
  ],
  related: [
    "/features/trade-cards-for-pkn",
    "/features/seller-fees",
    "/features/card-inventory",
  ],
});

export const HUBS = [
  {
    path: "/features",
    label: "Pokoin tools",
    kind: "hub",
    category: "Your card world, together",
    title: "Card Scanner, Collection Tracker, Inventory & Poko | Pokoin",
    description:
      "Explore everything Pokoin offers: browser card scanning, collection and portfolio tracking, seller inventory, Poko AI assistant, marketplace, and CardRails inventory.",
    headline: "Find the tool for your next card move.",
    intro:
      "Pokoin brings card recognition, a collection tracker, seller inventory, an AI assistant, and a trading card marketplace into one browser experience. Start with the task in front of you and keep the same card context as you explore.",
    answer:
      "Identify a card, organise what you own, prepare sale stock, or research a printing. Public research pages are available to browse; collection, inventory, and Poko use your signed-in account.",
    cards: FEATURES.map((page) => page.path),
    primary: cta("Try a card lookup", "/scan"),
    secondary: cta("Explore the marketplace", "/marketplace"),
    sections: [
      section(
        "Start with a real task",
        [
          "If you have physical cards to record, use the scanner and Scan Connect. If your sale stock is already in a file, use the spreadsheet workflow. If you are deciding what to collect next, browse an expansion, follow an illustrator, or ask Poko about a specific printing.",
        ],
        {
          links: [
            cta(
              "Scan a pile into a reviewed batch",
              "/learn/scan-cards-to-inventory",
            ),
            cta(
              "Bring stock from a spreadsheet",
              "/learn/import-card-inventory",
            ),
          ],
        },
      ),
      section(
        "Choose the platform that fits you",
        [
          "Looking for an alternative to an existing collection app or marketplace? Compare the workflows and current product information. Pokoin is browser-based, has no public native app-store listing yet, and supports card payments plus seller-accepted PKN.",
        ],
        {
          links: [cta("Compare Pokoin with other card tools", "/alternatives")],
        },
      ),
    ],
    faqs: [
      faq(
        "Is Pokoin only a token website?",
        "No. Pokoin includes a card scanner, personal collection and portfolio, seller inventory, Poko assistant, marketplace, and CardRails inventory. Card checkout supports Stripe and seller-accepted PKN.",
      ),
      faq(
        "Can I use Pokoin from a browser?",
        "Yes. The website tools work in a browser on phone and desktop. CardRails provides a dedicated workspace for managing card stock.",
      ),
    ],
    related: ["/alternatives", "/learn"],
  },
  {
    path: "/alternatives",
    label: "Compare card tools",
    kind: "hub",
    category: "A better fit starts with your task",
    title: "Trading Card App & Marketplace Alternatives | Pokoin",
    description:
      "Compare Pokoin with Collectr, Dragon Shield, TCGplayer and Cardmarket. Real CardTrader and TCGplayer price data, scanning and collection tools together.",
    headline: "An alternative built on real market data.",
    intro:
      "Real market data from CardTrader and TCGplayer. Scanning, collection tracking, seller tools and Poko in one browser workspace.",
    answer:
      "See where a price comes from. Compare CardTrader asking prices and dated TCGplayer aggregate quotes where available, then choose the tools that fit your cards.",
    cards: ALTERNATIVES.map((page) => page.path),
    primary: cta("Explore Pokoin’s tools", "/features"),
    secondary: cta("Try a card lookup", "/scan"),
    sections: [
      section("What these comparisons cover", [
        "Each page links the competitor’s primary sources, explains Pokoin’s relevant workflow, and names the differences you should check before switching. Use each comparison to check the tasks, account requirements, and marketplace differences that matter to you.",
        "These comparisons are published by Pokoin. Competitors are independent products, and their plans and capabilities can change. A small trial with cards you can verify is more useful than importing an entire collection before checking the workflow.",
      ]),
      section(
        "A few Pokoin details to know first",
        [
          "Pokoin runs in the browser. Signed-in tools include collection, inventory, and Poko. Scan Connect pairs a phone with a desktop review queue. Card payments use Stripe, with PKN also available where sellers accept it. Native App Store and Google Play listings are not available yet.",
          "Use the feature pages to understand the task, then open the actual tool when you are ready.",
        ],
        {
          links: [
            cta("Explore the scanner", "/features/card-scanner"),
            cta("Explore collection tracking", "/features/collection-tracker"),
            cta("Explore seller inventory", "/features/card-inventory"),
          ],
        },
      ),
    ],
    related: ["/features", "/learn"],
  },
  {
    path: "/learn",
    label: "Practical card workflows",
    kind: "hub",
    category: "From question to next step",
    title: "Card Scanning & Inventory How-To Guides | Pokoin",
    description:
      "Practical Pokoin guides for scanning cards into a reviewed collection or listing batch and importing seller stock from a spreadsheet.",
    headline: "Less guesswork. A clear next step.",
    intro:
      "These guides walk through real Pokoin workflows: identifying physical cards, reviewing printings and attributes, and bringing stock into the right destination. Start with a small batch so you can check the results against the cards you own.",
    answer:
      "Choose the scan walkthrough for a physical pile. Choose the spreadsheet walkthrough for existing sale stock in a file. Collection ownership and sale listings are different destinations.",
    cards: GUIDES.map((page) => page.path),
    primary: cta("Explore the tools", "/features"),
    secondary: cta("Open My Pokoin", "/mypokoin"),
    sections: [
      section(
        "Keep the printing and the physical copy together",
        [
          "Set, collector number, language, and finish identify the catalog printing. Condition, quantity, and storage location describe the copies you own. Review both before confirming a collection or listing batch.",
          "For Pokémon card-condition and rarity reference material, the marketplace’s catalog guides remain available alongside these workflow walkthroughs.",
        ],
        {
          links: [
            cta("Browse Pokémon catalog guides", "/marketplace/en/guides"),
          ],
        },
      ),
    ],
    related: [
      "/features/card-scanner",
      "/features/card-inventory",
      "/alternatives",
    ],
  },
].map((page) => ({ ...page, reviewed: REVIEWED }));

export const PRODUCT_PAGES = [...HUBS, ...FEATURES, ...ALTERNATIVES, ...GUIDES];
export function productPageForPath(pathname) {
  const canonical = String(pathname).replace(/\/+$/, "") || "/";
  return PRODUCT_PAGES.find((page) => page.path === canonical) || null;
}
