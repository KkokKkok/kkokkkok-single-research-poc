# 단서 유용성 구조화 및 참조 이미지 평가 계획

작성일: 2026-11-11. 상태: 설계안. 현재 코드·기존 분석 결과를 변경하거나 모델·지도 API를 실행한 문서가 아니다.

## 1. 목표와 평가 범위

사진에서 추출한 단서마다 (1) 무엇이 보이는지, (2) 어떤 위치 확인 방식에 활용할 수 있는지, (3) 그 판단을 어떤 외부 근거가 지지하는지, (4) 비교 후보들 사이에서 실제로 얼마나 도움이 됐는지를 분리해 저장한다.

사용자가 제공한 정답 위도·경도로 확보한 참조 사진을 이용하면 단서의 재현 여부와 이미지 대응을 평가할 수 있다. 그러나 정답 위치에서 가져온 사진만 보여주고 일치한다고 답하게 하는 실험은 위치 추론 성공 평가가 아니다. 정답 후보와 오답 후보를 함께 제시한 평가, 정답을 제공하지 않은 위치 예측 평가는 별도 실험으로 구분한다.

초기 구현은 기존 VLM을 호출하는 비교·평가 파이프라인으로 충분하다. 새 모델 학습은 필요조건이 아니다. 사람 검토가 쌓인 뒤 별도 평가 모델 학습을 검토한다.

## 2. 논문에서 가져올 항목과 새로 설계할 항목

| 근거 | 확인한 내용 | 계획에 적용 | 구분 |
|---|---|---|---|
| DoxBench / GeoMiner | 단서 추출과 후속 추론을 분리 | 추출 결과를 먼저 고정한 뒤 평가 단계에서 소비 | 논문의 단계 분리 취지 적용 |
| DoxBench | 정답 위치가 있는 평가 | 예측 결과와 정답을 서버가 비교 | 최종 위치 성능 평가 시 적용 |
| ClueMiner 공개 코드 | 수집 단서의 범주 정리 | 자유 범주 원문과 정규화 범주를 함께 보존 | 오프라인 분류 관리 |
| Beyond 첨부 프롬프트 | 일반 문구·체인·지역/연락 식별자·구체적 주소/상호의 가치 구분 | textEvidence 유형과 근거 필드 | 원문 등급을 자체 정성 계약으로 변환 |
| Beyond 첨부 XDSL | 환경 상세 분석·공간 모델링·검색 엔진 방법·외부 도구 활용·사용자 배경 분석 노드 | 단서가 어떤 검증 경로에 기여할지 명시 | 이미지 단위 방법을 단서 단위로 옮기는 것은 신규 설계 |
| Beyond 첨부 구현 | 화각·시점·날씨·시간·선명도와 다른 특성 결합 | 비교 가능성 및 관측 품질을 별도 기록 | 입력 특성의 취지 적용 |
| 신규 | 정답을 가린 참조 이미지 비교·어려운 오답·단서 제거 실험 | 검증과 기여도 평가 | 논문 원문 재현이라고 주장하지 않음 |

Beyond 논문 본문 전체를 확보해 대조한 것은 아니다. 공개 초록과 사용자 제공 코드·XDSL을 근거로 한다. 초록은 11개 지표·5개 방법을 설명하지만 첨부 모델에는 루트 입력 12개와 별도 중간 노드가 있어 동일 버전으로 단정하지 않는다. XDSL의 노드 연결도 그 자체로 실제 인과관계를 입증하지 않는다.

이번 사진 단서 평가에서는 사용자 배경 분석을 포함하지 않는다. 게시물 정보가 없는 사진에 task_attractiveness나 geo_hint를 추측해서 채우지 않는다. GeoCLIP 유사도 및 베이지안 IsSolved 확률을 개별 단서의 유용성 확률로 변환하지 않는다.

## 3. 단서별 구조화 계약

기존 observation·OCR 원문·bbox·원본 응답은 유지하고 별도 utilityAssessment와 evaluationRuns를 추가한다. 아래 enum과 필드명은 새 설계이며 논문의 원래 JSON 계약이 아니다.

| 영역 | 제안 필드 | 판단 내용 |
|---|---|---|
| 관찰 | claim, visibleText, attributes, sourceRegionIds | 픽셀에서 확인 가능한 짧은 주장과 근거 영역 |
| 실재성 | observationStatus | supported / partial / unsupported / unknown |
| 출처 | surface | fixed / movable / reflection / overlay / depicted / unknown |
| 문자 성격 | textEvidence.type | generic_copy / shared_brand / regional_identifier / contact / venue_name / branch / full_address / partial_identifier / none / unknown |
| 활용 경로 | utilityMechanisms[] | identifier_lookup / regional_constraint / landmark_lookup / appearance_match / spatial_relation_match / contextual_support |
| 경로별 근거 | mechanismEvidence[] | 경로, 관찰 ID, 기대되는 사용 방식, 필요한 검증, 반증 조건 |
| 비교 가능성 | comparability | 판독·가림·시점·거리·시기·실내외·반사 문맥 |
| 가설 상태 | hypothesisStatus | potential / insufficient / irrelevant |
| 외부 확인 | referenceChecks[] | 참조 ID, 비교 영역, 지지·모순 주장, 상태와 간단한 근거 |
| 후보 구별력 | discrimination | 평가 후보 집합 ID, 정답 순위·오답 선택·보류 및 제거 실험 결과 |
| 감사 기록 | provenance | 원문 출처, 프롬프트·모델·규칙 버전, 입력 해시, 실행 시각 |

utilityMechanisms는 복수 가능하다. 상호는 identifier_lookup, 창문 간격·외벽 패턴은 appearance_match, 출입구와 창문의 상대적 배치는 spatial_relation_match가 될 수 있다. 넓은 범주의 식생을 본 것만으로 regional_constraint를 확정하지 않는다. 구체적인 연결 근거가 없으면 contextual_support 또는 insufficient로 남긴다.

가시성, 위치 관련성, 영역 대응, 외부 확인, 후보 구별력을 합쳐 하나의 high/medium/low로 출력하지 않는다. 한 장소에서 같은 특징을 확인해도 전 세계 유일성을 확인한 것은 아니다.

### 예시 계약 — 실제 검증 결과 아님

```json
{
  "cueId": "cue-example",
  "utilityAssessment": {
    "version": "cue-utility-v2-proposal",
    "textEvidence": {"type": "venue_name", "readingStatus": "supported"},
    "surface": "fixed",
    "utilityMechanisms": ["identifier_lookup"],
    "mechanismEvidence": [{
      "mechanism": "identifier_lookup",
      "claim": "물리적 간판의 상호 문자열을 장소 자료와 대조할 수 있다",
      "sourceRegionIds": ["region-example"],
      "requiredValidation": ["동명 업소 구별", "지점 정보 확인", "주변 구조 비교"]
    }],
    "hypothesisStatus": "potential",
    "externalStatus": "not_evaluated",
    "discrimination": null
  }
}
```

## 4. 좌표 파일과 참조 이미지 준비

좌표 입력은 `image_id, filename, image_sha256, latitude, longitude, accuracy_m, captured_at, heading_deg, location_role, source`를 권장한다. 정확도·시각·방향을 모르면 null을 사용한다. location_role은 camera_position / depicted_place / unknown으로 구분한다. 좌표는 사진 속 건물 위치와 촬영자 위치가 다를 수 있으므로 제공 파일의 의미부터 확인한다. 위경도 범위·좌표계(WGS84)·파일 연결을 검증하고 동일 사진 여부는 해시로 확인한다.

정답 파일은 평가 전용 저장소에서 관리한다. 추출 모델·유용성 가설 생성 모델에는 정답 좌표, 주소, 좌표가 들어간 파일명, 사람이 작성한 정답 설명을 전달하지 않는다.

참조 수집기는 좌표 주변의 거리뷰 등에서 대응 가능한 시점과 방향을 찾는다. 각 참조는 요청 좌표와 실제 파노라마 촬영 좌표, 촬영 시기, heading/pitch/FOV, provider, reference_id, coverage 상태를 구분한다. 지도 평면 스크린샷은 간판·외벽의 시각 대조에 충분하지 않다. 실내·반사·높은 시점은 거리뷰와 대응되지 않을 수 있다.

Google Street View metadata API는 가용 여부, 파노라마 좌표·ID·촬영일 등을 제공한다. 촬영일은 없거나 연도만 있을 수 있다. 정답 GPS 근처 파노라마가 원본의 촬영 지점·방향을 보장하지는 않는다.

지도 서비스에서 이미지를 볼 수 있다는 사실만으로 모델 전송·저장·특징 추출·학습에 사용할 수 있다고 가정하지 않는다. Google 공식 정책에는 추출·저장·파생 콘텐츠 제한이 있다. 따라서 지도 이미지 공급자는 자동 비교·보관·모델 처리에 필요한 이용 범위를 확인한 뒤 선택한다. 허용되는 참조를 확보하기 전에는 직접 촬영한 대응 사진이나 해당 사용이 허용된 데이터로 같은 평가 구조를 실행한다. 참조 이미지 저장/전송 가능 여부와 화면 표시 가능 여부를 별도로 관리한다.

## 5. 평가 파이프라인

### A. 정답 장소 참조에 의한 단서 검증

1. 원본 사진에서 기존 파이프라인으로 추출하고 utilityAssessment 가설을 생성한다.
2. 사진·단서·프롬프트·모델 버전과 결과 해시를 저장해 평가 전에 고정한다.
3. 평가 전용 수집기가 정답 좌표를 이용해 참조 이미지를 확보한다.
4. 먼저 참조의 비교 가능성을 판정한다. 거리뷰 없음, 잘못된 방향, 가림, 시기 차이, 실내외 불일치 등을 기록한다.
5. 비교 모델은 원본과 참조 이미지, 중립 ID, 고정된 단서만 받아 주장별 일치·모순·판단 불가를 출력한다. 정답 여부·주소·좌표·기존 모델의 확신·사람 판정은 전달하지 않는다.
6. 원본과 참조 양쪽에서 근거 영역을 제시한다. 가능하면 탐지/매칭 도구로 영역을 연결하고 좌표 형식과 영역 안 근거를 검토한다. 근거 영역을 확보하지 못하면 그 사실을 남긴다.
7. humanReview를 모델 결과와 별도 저장한다.

판정은 supported / contradicted / inconclusive / not_observable / no_reference로 나눈다. 참조에 안 보이는 경우를 즉시 contradicted로 판정하지 않는다. 예컨대 움직이는 버스가 거리뷰에 없는 것은 추출 오류의 증거가 아니다.

이 실험의 측정 대상은 정답 위치 주변 참조에서의 단서 재현·대응이다. 위치를 새로 추론한 성공률로 보고하지 않는다.

### B. 후보 장소 구별력 평가

정답 참조 외에 같은 업종·브랜드·비슷한 외관 등의 어려운 오답을 포함한다. 후보 선택 규칙과 개수, 참조 수·화질·가용성을 사전에 정하고 순서를 무작위화한다. 참조 파일명·메타데이터·지도 UI의 위치표시로 정답이 유출되지 않게 한다. 사진 자체의 간판 텍스트는 평가 대상인 시각 정보이므로 유지한다. 서로 다른 방향의 동일 파노라마를 서로 다른 장소처럼 세지 않는다.

판정 모델은 후보마다 지지·모순 근거를 작성하고 순위 또는 none/uncertain을 출력한다. 정답이 없는 후보 집합도 포함해 억지 일치율을 측정한다. 순위가 고정된 뒤 서버가 비공개 정답표와 비교한다. 이 결과는 제한된 후보 집합에서의 성능이며 전 세계 위치 추론 성능이 아니다.

### C. 단서별 기여도 평가

같은 후보 집합에서 전체 단서, 해당 단서만, 해당 단서를 제외한 조건을 비교한다. 동일 표지의 OCR 조각은 묶어서 제거해 중복 단서로 우회하지 못하게 한다. 단서 목록에서 글자만 지우고 원본 사진을 그대로 보여주면 모델이 픽셀에서 다시 읽을 수 있다. 따라서 다음 두 실험을 분리한다.

- 단서 설명만으로 순위를 정하는 실험: 단서 JSON 전달의 기여 측정.
- 원본 사진 영역을 가리는 실험: 시각 정보의 기여 측정. 마스킹 부작용과 가려진 주변 단서를 함께 기록.

정답 순위·Top-k 변화는 해당 후보 집합에서의 한계 기여도로 해석한다. 상호작용 때문에 단일 단서를 제거해도 변화가 없을 수 있으며 이를 무조건 무용한 단서로 판정하지 않는다. 모델 점수를 곧바로 성공 확률로 부르지 않는다.

### D. 정답 비공개 위치 추론 평가 — 후속 별도 실험

실제 위치 추론 성능을 측정하려면 정답으로 후보를 구성하는 실험과 분리한다. 모델/검색기가 원본 단서만으로 예측을 제출하고 결과를 고정한 뒤 서버가 정답 GPS와 거리를 계산한다. 지도 참조는 그 후 사후 분석에 쓸 수 있다. 정답 주변만 탐색한 결과를 독립 위치 추론 성공으로 보고하지 않는다.

## 6. GPT 판정 자체의 평가

모델에게 자기 답변이 맞는지 묻는 것만으로 자동 정답을 만들지 않는다. 비교 모델은 별도 호출·문맥으로 실행하고 정답 라벨과 추출기의 장황한 설명을 받지 않는다. 다른 모델 사용은 오류 상관을 줄이는 실험 조건일 뿐 독립성을 보장하지 않는다.

GPT가 제출할 것은 숨은 사고 과정이 아니라 검증 가능한 짧은 주장이다: `cueId, referenceId, sourceRegionId, referenceRegionId, observableAgreement, observableConflict, limitations, verdict`. 소프트웨어는 참조 ID·영역 범위·필수 근거를 검증한다. 별도 사진 쌍에 대한 사람 라벨로 모델의 오일치·오거절·보류를 평가한다. 사람 판단도 모호하면 보류한다.

초기 10장 완료분은 프로토콜 개발용 파일럿으로 사용한다. 이미 결과를 보며 규칙을 바꾼 데이터이므로 독립 시험 데이터라고 부르지 않는다. 이후에는 같은 장소·중복 사진·동일 파노라마를 한 그룹으로 묶어 개발/평가 분할을 고정한다. 실패한 참조 수집 사례를 제외해 성능이 좋아 보이지 않도록 coverage와 평가 가능한 사례 수를 함께 보고한다.

## 7. 지표와 보고 기준

| 축 | 지표 |
|---|---|
| 입력·참조 | 좌표 연결 성공률, 참조 확보율, 비교 가능률, 시기·시점 불일치 수 |
| 관찰·유용성 분류 | 사람 정답 대비 판독·표면·정보 유형·활용 경로의 오류와 보류 |
| 참조 대응 | 비교 가능한 쌍에서 오일치·오거절, 판정 보류율; 사람 근거 영역이 있을 때 영역 대응 |
| 후보 구별 | 고정된 후보 규모에서 Top-1/Top-k, 정답 없는 집합의 오선택률 |
| 단서 기여 | 조건별 순위 및 성공률 변화, 중복 그룹 처리, 반복 실행 변동 |
| 위치 예측 | 별도 비공개 평가에서 예측과 정답의 거리·사전 지정 반경 내 성공률 |
| 비용 | 단계별 호출·토큰·시간과 재시도; 기존 분석 재사용 표시 |

미리 정한 분모와 제외 사유를 기록한다. 비교 모델의 근거 문장이 설득력 있다는 이유만으로 정답 처리하지 않는다. 총 단서 수·supported 수는 정확도 지표가 아니다.

## 8. 구현 순서와 완료 조건

1. **구조화 계약:** 현재 cues[]에 유용성 가설 필드를 별도로 붙이고 기존 서버 정책을 연결. 원문·정규화·사람 검토 분리. 완료 조건은 모든 필드의 정의·출처·보류 조건 확정.
2. **정답 입력·참조 어댑터:** 좌표 매니페스트와 분석 이미지 ID 연결, 정답 접근을 평가 모듈로 제한. 사용 가능한 참조 공급원 확보. 완료 조건은 좌표 오류·참조 없음·시점 불일치를 표현할 수 있음.
3. **참조 비교 파일럿:** 제공된 10장 중 참조가 있는 사진으로 A를 실행하고 사람이 검토. 완료 조건은 양쪽 근거와 불일치·관측 불가가 저장되고 원본 분석이 보존됨.
4. **후보 구별 실험:** B와 C를 구현. 완료 조건은 정답 비공개·후보 랜덤화·정답 없는 조건·정보 누출 방지가 확인됨.
5. **후속 성능 검증:** 새 장소에서 사람 라벨과 비교해 평가 모델을 점검. 실제 위치 추론 목표가 필요할 때 D를 별도 실행.

예정 코드 단위: utility-contracts / utility-policy / reference-provider / pair-review / evaluation-runner. 현재 `contracts.mjs`·`prompts.mjs`·`pipeline.mjs`에는 계획을 확정한 뒤 버전 추가 방식으로 연결한다. 기존 humanReviews와 학습용 정답을 추출 입력으로 혼합하지 않는다. 지도 API 키·사진별 정답 좌표·사용 가능한 참조 이미지 제공 방식은 실제 구현 전에 필요한 입력이다.

## 자료

- [DoxBench/GeoMiner 논문 초록](https://arxiv.org/abs/2504.19373): 단서 추출과 추론의 두 단계 구조.
- [DoxBench 공개 코드](https://github.com/SaFo-Lab/DoxBench/blob/main/code/experiment/experiment.py#L215-L281): Detector와 후속 추론 프롬프트.
- [Beyond the Geotag 초록](https://www.tandfonline.com/doi/abs/10.1080/13658816.2026.2623524): 특성·방법·취약성의 베이지안 네트워크.
- 첨부 근거: `work/beyond-geotag/code/src/1_data_preprocessing/picture_vlm_analyze.py`, `work/beyond-geotag/code/src/2_model/pretrained_network.xdsl`.
- [Street View 메타데이터](https://developers.google.com/maps/documentation/streetview/metadata): 참조 가용 여부·촬영 위치·시기.
- [Street View 이용 정책](https://developers.google.com/maps/documentation/streetview/policies): 추출·저장·파생 콘텐츠 관련 제한. 공급원 확정 시 해당 서비스 조건 재확인.
