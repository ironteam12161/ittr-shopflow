/* ITTR ShopFlow inspection checklist - shared by the browser app and the server (PDF). */
(function(root){
'use strict';
const TRUCK_SECTIONS=[
 {id:'engine',title:'1. ENGINE / ДВИГУН / ПІДКАПОТНИЙ ПРОСТІР',items:[
  ['engine_oil','Моторна олива / Engine oil — рівень / стан / витоки'],['coolant','Антифриз / Coolant — рівень / стан / витоки'],['fuel_system','Паливна система / Fuel system — витоки'],['belts','Ремені / натягувачі'],['hoses','Патрубки / хомути / шланги'],['intake','Повітряний фільтр / intake / intercooler'],['turbo','Турбіна — люфт / витоки'],['radiator_fan','Радіатор / fan / fan clutch'],['electrical_start','Акумулятори / клеми / генератор / стартер'],['air_compressor','Компресор повітря / витоки']
 ]},
 {id:'brakes',title:'2. BRAKES / ГАЛЬМА',items:[
  ['brake_steer','Steer axle — колодки / барабани або ротори LH/RH'],['brake_drive1','Drive axle 1 — колодки / барабани LH/RH'],['brake_drive2','Drive axle 2 — колодки / барабани LH/RH'],['slack_chambers','Slack adjusters / brake chambers'],['brake_hoses','Гальмівні шланги / фітинги'],['air_leaks_tanks','Витоки повітря / ресивери'],['abs','ABS — лампа / датчики / проводка'],['parking_brake','Паркувальне гальмо']
 ]},
 {id:'steering',title:'3. STEERING / РУЛЬОВЕ / ПЕРЕДНЯ ВІСЬ',items:[
  ['steering_linkage','Steering gear / drag link / tie rod'],['steering_play','Наконечники / люфт рульового'],['king_pins','King pins — люфт'],['front_bearings','Передні ступиці / підшипники — люфт'],['front_seals','Передні wheel seals — витік']
 ]},
 {id:'suspension',title:'4. SUSPENSION / ПІДВІСКА / РЕСОРИ',items:[
  ['front_springs','Передні ресори LH/RH — тріщини / стан'],['front_spring_bushings','Бушинги передніх ресор LH/RH'],['rear_bushings','Бушинги задньої підвіски / ресор'],['air_bags','Пневмоподушки — стан / витоки'],['shocks','Амортизатори / shocks'],['ubolts_torque','U-bolts / torque rods / bushings'],['brackets_rideheight','Кронштейни / ride height / рама']
 ]},
 {id:'tires',title:'5. TIRES / ШИНИ / КОЛЕСА / HUBCAPS',items:[
  ['steer_tires','Steer tires LH/RH — протектор / пошкодження / тиск'],['drive1_tires','Drive axle 1 — шини / протектор / тиск'],['drive2_tires','Drive axle 2 — шини / протектор / тиск'],['rims_lugs','Диски / гайки / шпильки'],['lh_hubcap','Передній LH hubcap — рівень масла / витік'],['rh_hubcap','Передній RH hubcap — рівень масла / витік'],['rear_seals','Задні wheel seals / hubcaps — витоки']
 ]},
 {id:'cab',title:'6. CAB / КАБІНА / HVAC / СКЛО',items:[
  ['cab_bushings','Бушинги кабіни LH/RH'],['cab_shocks','Cab shocks / амортизатори кабіни LH/RH'],['cab_mounts','Кріплення / замки кабіни'],['windshield','Лобове скло — сколи / тріщини'],['mirrors_doors_belts','Дзеркала / двері / ремені безпеки'],['ac','Кондиціонер — холод / компресор / робота'],['heater','Пічка — нагрів / blower / defroster'],['wipers','Склоочисники / омивач']
 ]},
 {id:'hoses_lights',title:'7. 3-IN-1 / ШЛАНГИ / КАБЕЛІ / СВІТЛО',items:[
  ['three_in_one','3-in-1 cable — кабель / air lines / розʼєми'],['three_in_one_rub','3-in-1 — чи ніде не треться'],['all_hoses','Всі шланги — потертості / тріщини / кріплення'],['all_wiring','Вся проводка — потертості / оголені дроти'],['moving_clearance','Шланги / кабелі не торкаються кардана / вихлопу / рухомих частин'],['lights','Фари / габарити / поворотники / стопи'],['horn_warnings','Клаксон / warning lights']
 ]},
 {id:'frame_transmission',title:'8. FIFTH WHEEL / РАМА / ТРАНСМІСІЯ',items:[
  ['fifth_wheel','Fifth wheel — jaws / lock / wear / cracks'],['fifth_mount','Fifth wheel — кріплення / мастило'],['frame','Рама / crossmembers — тріщини / пошкодження'],['driveline','Кардан / U-joints / carrier bearing'],['trans_diff_axles','Transmission / differential / axles — витоки'],['fuel_tanks','Паливні баки / кріплення / витоки']
 ]},
 {id:'emissions',title:'9. DPF / DEF / ДІАГНОСТИКА',items:[
  ['exhaust','Вихлоп — витоки / кріплення'],['aftertreatment','DPF / DOC / SCR / DEF — візуальний стан'],['warning_lights','Check Engine / ABS / warning lights'],['fault_codes','Активні / збережені коди несправностей']
 ]},
 {id:'final',title:'10. FINAL / ФІНАЛЬНА ПЕРЕВІРКА / TEST DRIVE',items:[
  ['oil_temp','Тиск оливи / температура двигуна'],['air_pressure','Набір та утримання тиску повітря'],['road_brakes_steering','Гальма / рульове керування'],['shifting','Transmission / shifting'],['vibration_noise','Вібрації / сторонні шуми'],['engine_brake_cruise','Engine brake / cruise control'],['post_drive_leaks','Повторна перевірка витоків після test drive']
 ]}
].map(s=>({...s,items:s.items.map(([id,label])=>({id,label}))}));

const TRAILER_SECTIONS=[
 {id:'frame',title:'1. FRAME / РАМА / КУЗОВ / LANDING GEAR',items:[
  ['main_rails','Main rails / рама — тріщини, вигини, корозія'],['crossmembers','Crossmembers / поперечини'],['nose','Передня стінка / nose'],['side_panels','Бокові стінки / panels'],['roof','Дах — пошкодження / протікання'],['floor','Підлога — тріщини / отвори'],['icc_bumper','ICC bumper / rear impact guard'],['landing_gear','Landing gear — ноги / crank / gearbox'],['kingpin','Kingpin / upper coupler plate'],['mudflaps','Mud flaps / brackets']
 ]},
 {id:'brakes',title:'2. BRAKES / ГАЛЬМА',items:[
  ['axle1_lh_brake','Axle 1 LH — колодки / барабан або ротор'],['axle1_rh_brake','Axle 1 RH — колодки / барабан або ротор'],['axle2_lh_brake','Axle 2 LH — колодки / барабан або ротор'],['axle2_rh_brake','Axle 2 RH — колодки / барабан або ротор'],['slack_chambers','Slack adjusters / brake chambers'],['scams','S-cams / bushings / rollers'],['air_hoses','Air lines / hoses / fittings'],['air_leaks','Витоки повітря'],['abs','ABS — lamp / sensors / wiring']
 ]},
 {id:'suspension',title:'3. SUSPENSION / ПІДВІСКА / ОСІ',items:[
  ['air_bags','Air bags — тріщини / витоки'],['shocks','Shocks'],['torque_rods','Torque rods / bushings'],['spring_bushings','Spring / suspension bushings'],['ubolts','U-bolts / кріплення'],['axles','Axles — тріщини / пошкодження'],['hangers','Hangers / brackets'],['ride_height','Ride height / leveling valve'],['slider','Slider rails / pins / locks']
 ]},
 {id:'tires',title:'4. TIRES / ШИНИ / КОЛЕСА / HUBCAPS',items:[
  ['axle1_lh_tires','Axle 1 LH inner/outer — протектор / тиск / пошкодження'],['axle1_rh_tires','Axle 1 RH inner/outer — протектор / тиск / пошкодження'],['axle2_lh_tires','Axle 2 LH inner/outer — протектор / тиск / пошкодження'],['axle2_rh_tires','Axle 2 RH inner/outer — протектор / тиск / пошкодження'],['rims','Rims / диски'],['lug_nuts','Lug nuts / studs'],['hubcaps','Hubcaps — рівень масла / витоки'],['wheel_seals','Wheel seals — витоки'],['wheel_bearings','Wheel bearings — люфт / шум']
 ]},
 {id:'electric',title:'5. AIR / ELECTRIC / СВІТЛО',items:[
  ['seven_way','7-way electrical plug / cable'],['service_air','Service air line / gladhand'],['emergency_air','Emergency air line / gladhand'],['line_rubbing','Air lines / кабель — чи ніде не труться'],['under_wiring','Проводка під трейлером — потертості / кріплення'],['marker_lights','Marker / clearance lights'],['turn_stop_tail','Turn / stop / tail lights'],['plate_light','License plate light'],['abs_light','ABS light']
 ]},
 {id:'doors',title:'6. DRY VAN / REEFER — ДВЕРІ ТА ВНУТРІШНІЙ СТАН',applies:['dry_van','reefer'],items:[
  ['rear_doors','Задні двері — петлі / замки / rods'],['door_seals','Door seals / ущільнювачі'],['door_operation','Двері правильно відкриваються / закриваються'],['inside_walls','Внутрішні стіни / scuff liner'],['inside_floor','Підлога всередині'],['inside_roof','Дах зсередини — сліди протікання'],['cargo_rails','Cargo rails / E-track']
 ]},
 {id:'reefer',title:'7. REEFER UNIT — ЯКЩО Є',applies:['reefer'],items:[
  ['reefer_run','Reefer unit — запуск / робота / шуми'],['reefer_oil','Engine oil — рівень / витоки'],['reefer_coolant','Coolant — рівень / витоки'],['reefer_belts','Ремені / натягувачі'],['reefer_battery','Battery / terminals'],['reefer_fuel_lines','Fuel tank / lines — витоки'],['reefer_fuel_level','Reefer fuel level'],['reefer_condenser','Condenser / radiator'],['reefer_evaporator','Evaporator / fans'],['reefer_temp','Набирає задану температуру'],['reefer_codes','Controller / fault codes'],['reefer_drains','Drain tubes / seals']
 ]},
 {id:'conestoga',title:'8. CONESTOGA — ТЕНТ / МЕХАНІЗМ',applies:['conestoga'],items:[
  ['tarp','Тент — порізи / дірки / потертості'],['tarp_seals','Переднє / заднє ущільнення тенту'],['roof_bows','Roof bows / арки'],['rollers','Каретки / rollers'],['rails','Rails / направляючі'],['locking','Locking mechanism / ручки'],['rear_frame','Rear frame / bulkhead'],['front_bulkhead','Front bulkhead'],['open_close','Тент повністю відкривається / закривається'],['straps','Straps / buckles'],['water_leaks','Протікання води / ущільнення']
 ]},
 {id:'final',title:'9. FINAL / ФІНАЛЬНА ПЕРЕВІРКА',items:[
  ['grease','Grease points / змащення'],['connected_air_leaks','Air leaks після підключення'],['all_lights','Всі lights після підключення'],['abs_self','ABS self-check'],['slider_locked','Slider pins заблоковані'],['landing_up','Landing gear піднятий'],['doors_locks','Двері / Conestoga locks закриті'],['hubcaps_recheck','Повторно hubcaps / wheel seals']
 ]}
].map(s=>({...s,items:s.items.map(([id,label])=>({id,label}))}));
function sectionsFor(inspection){const i=inspection||{};if(i.type==='truck')return TRUCK_SECTIONS;const subtype=String(i.subtype||'');return TRAILER_SECTIONS.filter(s=>!s.applies||s.applies.includes(subtype))}
function itemsFor(inspection){return sectionsFor(inspection).flatMap(s=>s.items.map(item=>({...item,sectionId:s.id,sectionTitle:s.title})))}
root.ITTRInspectionChecklist=Object.freeze({TRUCK_SECTIONS,TRAILER_SECTIONS,sectionsFor,itemsFor});
})(typeof window!=='undefined'?window:globalThis);
