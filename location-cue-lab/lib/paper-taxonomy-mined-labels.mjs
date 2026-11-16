// Display aids for the categories ClueMiner added to the paper's Figure 25 table (mining run
// mine-20261114T015710, 31 -> 84 categories). Not ClueMiner output and not from the paper: the
// grouping and the Korean names were written by a reviewer on 2026-11-14 so that 84 categories can be
// tallied and read. Category names and definitions are left exactly as mined; the classifier prompt
// carries neither the group nor the Korean name.
// Five groups are the paper's (Figure 25); two are new, for categories none of the five fits.
export const MINED_GROUPS={
  'Identification':['Written Language Script','Telephone Number Format','Building Name Lettering','Place Name Markers','Tenant Directory Boards','Infrastructure Asset Tags','Service Provider Decals','Enforcement Warning Notices','Transit Station Identifiers','Transit Vehicle Markings','Event Announcement Displays'],
  'Building Features':['Commercial Building Form','Institutional Building Form','Heritage Architecture','Repurposed Industrial Structures','Building Compound Layout','Interior Space Design'],
  'Urban Infrastructure':['Bridge Structures','Underpass Passages','Traffic Signal Equipment','Road Surface Markings','Cycle Path Infrastructure','Roadside Safety Barriers','Slope Retaining Structures','Towers And Masts','Surveillance Equipment','Vehicle Fleet Mix','Ornamental Landscape Lighting','Urban Sky Glow'],
  'Urban Planning':['Distant Skyline Profile','Viewpoint Spatial Alignment','Large Natural Waterbodies','Urban Waterways','Boat Mooring Facilities','Plaza Hardscape Furnishings','Sports Field Facilities','Visitor Information Fixtures'],
  'Property Features':['Ornamental Water Features','Decorative Installations','Flag Display Fixtures'],
  'Commerce and Consumption':['Local Business Advertisements','Premises Operating Notices','Retail Store Fixtures','Merchandise Assortment','Portable Branded Items','Transaction Record Labels','Storefront Service Format','Venue Theme Styling'],
  'People, Season and Image':['Clothing And Attire','Crowd Composition','Vegetation Seasonal State','Seasonal Festive Decorations','Media Overlay Content'],
};
export const MINED_GROUP_OF=Object.fromEntries(Object.entries(MINED_GROUPS).flatMap(([group,names])=>names.map(name=>[name,group])));
export const MINED_KOREAN={
  'Commerce and Consumption':'상점과 소비','People, Season and Image':'사람·계절·사진',
  'Written Language Script':'문자·언어','Telephone Number Format':'전화번호 형식','Building Name Lettering':'건물 이름 글자','Place Name Markers':'지명 표지','Tenant Directory Boards':'입점 업체 안내판','Infrastructure Asset Tags':'시설물 관리 번호표','Service Provider Decals':'보안·통신 업체 스티커','Enforcement Warning Notices':'단속 경고문','Transit Station Identifiers':'역·정류장 표지','Transit Vehicle Markings':'대중교통 차량 도색과 노선 표시','Event Announcement Displays':'행사 안내물',
  'Commercial Building Form':'상업 건물의 형태','Institutional Building Form':'공공 건물의 형태','Heritage Architecture':'전통·역사 건축','Repurposed Industrial Structures':'재활용된 산업 구조물','Building Compound Layout':'건물 단지의 배치','Interior Space Design':'실내 공간 디자인',
  'Bridge Structures':'다리','Underpass Passages':'지하 통로','Traffic Signal Equipment':'신호등','Road Surface Markings':'노면 표시','Cycle Path Infrastructure':'자전거 도로','Roadside Safety Barriers':'도로변 방호 울타리','Slope Retaining Structures':'옹벽','Towers And Masts':'탑과 송신탑','Surveillance Equipment':'감시 카메라','Vehicle Fleet Mix':'차량 구성','Ornamental Landscape Lighting':'조경 조명','Urban Sky Glow':'밤하늘의 도시 불빛',
  'Distant Skyline Profile':'먼 스카이라인','Viewpoint Spatial Alignment':'촬영 위치와 원경의 배치','Large Natural Waterbodies':'큰 강·호수','Urban Waterways':'도심 하천','Boat Mooring Facilities':'계류 시설','Plaza Hardscape Furnishings':'광장 바닥과 시설물','Sports Field Facilities':'운동장 시설','Visitor Information Fixtures':'방문객 안내 시설',
  'Ornamental Water Features':'연못·분수','Decorative Installations':'장식 조형물','Flag Display Fixtures':'깃발 게양대',
  'Local Business Advertisements':'다른 가게의 광고','Premises Operating Notices':'매장 운영 안내문','Retail Store Fixtures':'매장 집기와 가격표','Merchandise Assortment':'상품 구성','Portable Branded Items':'상표가 찍힌 휴대 물품','Transaction Record Labels':'영수증·주문 라벨','Storefront Service Format':'매장의 판매 창구 형태','Venue Theme Styling':'매장의 테마 꾸밈',
  'Clothing And Attire':'옷차림','Crowd Composition':'사람들의 구성','Vegetation Seasonal State':'식물의 계절 상태','Seasonal Festive Decorations':'계절 장식','Media Overlay Content':'사진에 얹은 자막·스티커',
};
