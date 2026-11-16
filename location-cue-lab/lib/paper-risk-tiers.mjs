// Risk tiers of the 84 clue categories (taxonomy 20261114T034655-5ce3eefa9b10): how far a clue of
// that category narrows down where a photo was taken. NOT from the paper and NOT measured: a reviewer
// read each category's name and definition on 2026-11-14 (see risk-tier-draft.md). A tier is the
// default for the category; single clues can deserve a higher one (the note says when), and only a
// per-clue check such as a place search can tell.
//   A  can name the place by itself (a shop name, a house number, a station sign)
//   B  narrows to a kind of area or a district, not to a place
//   C  country, season, or something found everywhere
// Used to decide where region linking spends its time (paper-regions.mjs linkRegions policy).
// 2026-11-15: 'Portable Branded Items' and 'Retail Store Fixtures' moved from B to A at the owner's
// request. A chain's name does not name the branch, but with anything else in the photo it does, and
// as tier B these clues got no box and could not even be reviewed.
// 2026-11-15 (later): 'Bridge Structures', 'Distant Skyline Profile' and 'Viewpoint Spatial Alignment'
// moved from B to A at the owner's request, after the mask experiment m1: two of the three photos whose
// place still came out after masking were found from a gate, a hill and a tower, or a riverside view.
export const RISK_TIER_VERSION='draft-2026-11-15';
export const RISK_TIERS={
  A:{
    'House Number':'번지 숫자 자체','Institutional Markers':'기관 이름·로고','Commercial Signage':'상호. 체인점이면 B (지점은 모름)','Community Features':'랜드마크·기관 건물. 흔한 건물이면 B',
    'Building Name Lettering':'건물·단지 이름','Place Name Markers':'다리·하천·공원 이름','Tenant Directory Boards':'입점 업체 조합으로 건물 특정','Infrastructure Asset Tags':'관리 번호와 지역명',
    'Transit Station Identifiers':'역 이름과 출구 번호','Event Announcement Displays':'행사 이름과 장소·기간','Telephone Number Format':'번호 전체가 보이면 업체 특정. 지역번호만이면 B',
    'Local Business Advertisements':'광고에 적힌 주소·층','Portable Branded Items':'상표로 체인 식별. 혼자서는 지점을 모르지만 다른 단서와 합쳐지면 장소가 나옴','Retail Store Fixtures':'매장 집기의 상표로 체인 식별','Transaction Record Labels':'지점 이름과 시각','Heritage Architecture':'알려진 문·궁·기념물. 흔한 전통 양식이면 B',
    'Bridge Structures':'다리의 모양과 위치. 알려진 다리면 혼자서 장소가 나옴','Distant Skyline Profile':'멀리 보이는 탑·고층 건물·산의 윤곽으로 방향과 지구가 나옴','Viewpoint Spatial Alignment':'보이는 대상들의 배치로 찍은 자리가 좁혀짐',
  },
  B:{
    'Residential Architecture':'','Facade Features':'','Entry Structure':'','Traffic Signage':'도로명·방면 표지면 A','Special Signs':'','Parking Regulations':'구 이름이 적혀 있으면 A','Waste Management':'구 이름이 적힌 봉투·수거함이면 A',
    'Environmental Features':'','Street Layout':'','Drainage / Transit':'지자체 문양이 있는 맨홀이면 A','Unique Design':'','Public Spaces':'','Transit Nodes':'',
    'Enforcement Warning Notices':'발급 기관(구청) 이름이 있으면 A','Transit Vehicle Markings':'노선 번호로 운행 지역','Commercial Building Form':'','Institutional Building Form':'','Repurposed Industrial Structures':'알려진 시설이면 A','Building Compound Layout':'',
    'Towers And Masts':'알려진 탑이면 A','Large Natural Waterbodies':'','Urban Waterways':'알려진 하천이면 A','Boat Mooring Facilities':'',
    'Visitor Information Fixtures':'','Decorative Installations':'알려진 조형물이면 A','Premises Operating Notices':'','Media Overlay Content':'자막에 지명·상호가 있으면 A',
  },
  C:{
    'Roof Elements':'','Balcony / Window Details':'','Accessory Structures':'','Vehicle Registration':'','Climate Indicators':'','Curbs':'','Pedestrian Elements':'','Public Lighting':'','Water / Power':'','Boundary Elements':'','Plant Types':'','Regional Landscaping':'','Outdoor Fixtures':'','Safety Elements':'',
    'Written Language Script':'','Service Provider Decals':'','Interior Space Design':'','Underpass Passages':'','Traffic Signal Equipment':'','Road Surface Markings':'','Cycle Path Infrastructure':'','Roadside Safety Barriers':'','Slope Retaining Structures':'','Surveillance Equipment':'','Vehicle Fleet Mix':'','Ornamental Landscape Lighting':'','Urban Sky Glow':'',
    'Plaza Hardscape Furnishings':'','Sports Field Facilities':'','Ornamental Water Features':'','Flag Display Fixtures':'','Merchandise Assortment':'','Storefront Service Format':'','Venue Theme Styling':'','Clothing And Attire':'','Crowd Composition':'','Vegetation Seasonal State':'','Seasonal Festive Decorations':'',
  },
};
const TIER_OF=new Map(Object.entries(RISK_TIERS).flatMap(([tier,names])=>Object.keys(names).map(name=>[name,tier])));
// The tier of a category name, or null for a name this table does not know (another taxonomy).
export const riskTierOf=name=>TIER_OF.get(name)??null;
export const riskTierNote=name=>{const tier=riskTierOf(name);return tier?RISK_TIERS[tier][name]:'';};

// Where region linking looks, by tier. Object detection is the slow part (about 6 s a phrase on this
// machine's CPU), so it runs for tier A only and for at most two phrases a clue. Matching quoted text
// against the OCR lines costs nothing extra (the photo is read once either way), so it also covers
// tier B, where a caption or a cup can carry a place name. A clue whose category has no tier (an
// unclassified clue, another taxonomy) is treated as tier A: unknown is not the same as harmless.
// skipObjectsForQuotedText (2026-11-16): 249 of the 529 detector phrases of the 152 photos belonged to clues
// that quote text. Their object boxes are never drawn or counted, so the detector is no longer asked.
export const TIERED_POLICY={name:'tiered',tierVersion:RISK_TIER_VERSION,objectTiers:['A'],textTiers:['A','B'],maxPhrasesPerClue:2,skipObjectsForQuotedText:true};
export const tierForLinking=clue=>riskTierOf(clue.taxonomy?.name)??'A';
