// The paper's own table of clue types, used as a fixed taxonomy until there are enough photos to
// mine one with ClueMiner.
// Source: arXiv:2504.19373v5, Figure 25 "Category and Clue Definition of Our Dataset with Examples"
// (the ICLR 2026 version is CC BY 4.0). The figure is an image; its three columns (Category, Clue,
// Example) were transcribed by reading it, row for row, in the figure's order.
// What this table is and is not:
// - The authors organised it by hand to count which clues OpenAI o3 used with tools (Figures 6, 20).
//   It is NOT the 102-category ClueMiner output, which the paper does not publish.
// - It describes the paper's dataset: house exteriors and streets, mostly in the United States.
//   Clues about interiors, food, overlaid captions or language have no type of their own here.
// - It gives examples but no definitions. The classifier prompt has a definition slot, so each
//   type's slot holds only text from the figure: "Category: <category>. Example: <examples>".
export const FIGURE25_SOURCE={paper:'arXiv:2504.19373v5, Figure 25 "Category and Clue Definition of Our Dataset with Examples"',license:'CC BY 4.0 (ICLR 2026 version, OpenReview uBThjlbzxS)',
  transcribedFrom:'figure image, read row by row',verbatim:true,madeBy:'authors, by hand (not ClueMiner)',definitionSlot:'Category: <category>. Example: <examples> (the figure has no definitions)'};

export const FIGURE25_TABLE=[
  {category:'Building Features',clues:[
    ['Residential Architecture','Tudor house, split-level house, ranch-style house, craftsman house, bungalow, modern infill housing'],
    ['Roof Elements','Dormer windows, gable roof, solar panel layout'],
    ['Facade Features','Red brick facade, brick color, multi-material facade (brick + stucco), facade ornamentation'],
    ['Entry Structure','Pergola entrance structure, front porch swing, door placement'],
    ['Balcony / Window Details','Balcony railing design, window style, window AC'],
    ['Accessory Structures','Garage door style, carport structure, garage orientation'],
  ]},
  {category:'Identification',clues:[
    ['House Number','House number plaque, address number'],
    ['Institutional Markers','School yard sign, university logo'],
    ['Traffic Signage','No parking sign, intersection street signs, directional route sign'],
    ['Special Signs','“Pedestrian Priority Zone”, railroad crossing signal, construction signage'],
    ['Commercial Signage','Business name, car share service, maintenance shop sign'],
    ['Parking Regulations','Permit number on parking sign, city-issued residential parking signage, ward identifier'],
    ['Waste Management','Garbage collection logo, city-specific waste bin color scheme, compost bin design'],
    ['Vehicle Registration','State license plate format'],
    ['Environmental Features','Hill slope, ocean horizon, open space'],
    ['Climate Indicators','Sunlight angle, solar panel direction'],
  ]},
  {category:'Urban Infrastructure',clues:[
    ['Curbs','Rounded concrete curb, granite curbs, curb street stamp'],
    ['Street Layout','Intersection layout, street slope, road sign'],
    ['Pedestrian Elements','Sidewalk width, sidewalk grass strip, sidewalk slope'],
    ['Public Lighting','Streetlight'],
    ['Water / Power','Fire hydrant color, wooden utility pole, underground utilities, utility pole position'],
    ['Drainage / Transit','Manhole cover design, bus shelter'],
  ]},
  {category:'Property Features',clues:[
    ['Unique Design','Driveway decorations, driveway layout, driveway landscaping, shrub placement'],
    ['Boundary Elements','White picket fence, wrought iron front yard fence, pink slump stone wall, triangular hedge, front yard brick fence'],
    ['Plant Types','Palm trees, deciduous trees, maple trees, Japanese maple, spiral topiary'],
    ['Regional Landscaping','Desert landscaping, greenbelt/open space, flowering tree type'],
    ['Outdoor Fixtures','Mailbox cluster, trash bin placement, garbage bins, Recology bin logo'],
  ]},
  {category:'Urban Planning',clues:[
    ['Public Spaces','Triangular park, dog park sign, school yard, church signboard'],
    ['Transit Nodes','Intersection, bike lane marking, cruise ship dock, airport control tower'],
    ['Community Features','Landmark, outer-borough house design, institutional architecture'],
    ['Safety Elements','Fire escape placement, security bars, construction zone'],
  ]},
];

// Korean display names for the preview and reports. Translations made for this project: they are
// never sent to a model and are not part of the paper.
export const FIGURE25_KOREAN={
  'Building Features':'건물 특징','Residential Architecture':'주택 건축 양식','Roof Elements':'지붕 요소','Facade Features':'외벽 특징','Entry Structure':'출입구 구조','Balcony / Window Details':'발코니·창문 세부','Accessory Structures':'부속 구조물',
  'Identification':'식별 표지','House Number':'번지 표지','Institutional Markers':'기관 표지','Traffic Signage':'교통 표지','Special Signs':'특수 표지','Commercial Signage':'상업 간판','Parking Regulations':'주차 규제 표지','Waste Management':'쓰레기 처리 시설','Vehicle Registration':'차량 번호판','Environmental Features':'지형·자연환경','Climate Indicators':'기후 지표',
  'Urban Infrastructure':'도시 기반 시설','Curbs':'연석','Street Layout':'도로 배치','Pedestrian Elements':'보행 시설','Public Lighting':'가로등','Water / Power':'수도·전력 시설','Drainage / Transit':'배수·대중교통 시설',
  'Property Features':'대지 특징','Unique Design':'고유한 디자인','Boundary Elements':'경계 요소','Plant Types':'식물 종류','Regional Landscaping':'지역 조경','Outdoor Fixtures':'실외 설치물',
  'Urban Planning':'도시 계획','Public Spaces':'공공 공간','Transit Nodes':'교통 결절점','Community Features':'지역 사회 시설','Safety Elements':'안전 시설',
};

// [{number,name,definition,group,example}] numbered 1..31 in the figure's order (a mined taxonomy is
// numbered alphabetically; this table has an order of its own, so it is kept).
export const figure25Categories=()=>FIGURE25_TABLE.flatMap(({category,clues})=>clues.map(([name,example])=>({name,group:category,example})))
  .map((row,index)=>({number:index+1,name:row.name,definition:`Category: ${row.group}. Example: ${row.example}`,group:row.group,example:row.example}));
