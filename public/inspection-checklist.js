/* ITTR ShopFlow inspection checklist - shared by the browser app and the server (PDF).
   Every section and item has English (en) and Ukrainian (uk) text. `label`/`title` are English:
   customer-facing output (PDF, work-order jobs) is always English; the mechanic screen follows the
   user's language setting. Item ids never change, so saved inspections keep working. */
(function(root){
'use strict';
const I=(id,en,uk)=>({id,en,uk,label:en});
const S=(sec)=>({...sec,title:sec.en});
const TRUCK_SECTIONS=[
 {id:'engine',en:'1. Engine / Under Hood',uk:'1. Двигун / підкапотний простір',items:[
  I('engine_oil','Engine oil — level / condition / leaks','Моторна олива — рівень / стан / витоки'),
  I('coolant','Coolant — level / condition / leaks','Антифриз — рівень / стан / витоки'),
  I('fuel_system','Fuel system — leaks','Паливна система — витоки'),
  I('belts','Belts / tensioners','Ремені / натягувачі'),
  I('hoses','Hoses / clamps','Патрубки / хомути / шланги'),
  I('intake','Air filter / intake / intercooler','Повітряний фільтр / впуск / інтеркулер'),
  I('turbo','Turbocharger — shaft play / leaks','Турбіна — люфт / витоки'),
  I('radiator_fan','Radiator / fan / fan clutch','Радіатор / вентилятор / муфта вентилятора'),
  I('electrical_start','Batteries / terminals / alternator / starter','Акумулятори / клеми / генератор / стартер'),
  I('air_compressor','Air compressor — leaks','Компресор повітря — витоки')]},
 {id:'brakes',en:'2. Brakes',uk:'2. Гальма',items:[
  I('brake_steer','Steer axle — brake linings / drums or rotors LH/RH','Передня вісь — колодки / барабани або ротори LH/RH'),
  I('brake_drive1','Drive axle 1 — brake linings / drums LH/RH','Ведуча вісь 1 — колодки / барабани LH/RH'),
  I('brake_drive2','Drive axle 2 — brake linings / drums LH/RH','Ведуча вісь 2 — колодки / барабани LH/RH'),
  I('slack_chambers','Slack adjusters / brake chambers','Регулятори (slack) / гальмівні камери'),
  I('brake_hoses','Brake hoses / fittings','Гальмівні шланги / фітинги'),
  I('air_leaks_tanks','Air leaks / air tanks','Витоки повітря / ресивери'),
  I('abs','ABS — lamp / sensors / wiring','ABS — лампа / датчики / проводка'),
  I('parking_brake','Parking brake','Паркувальне гальмо')]},
 {id:'steering',en:'3. Steering / Front Axle',uk:'3. Рульове / передня вісь',items:[
  I('steering_linkage','Steering gear / drag link / tie rod','Рульовий механізм / поздовжня / поперечна тяга'),
  I('steering_play','Tie rod ends / steering play','Наконечники / люфт рульового'),
  I('king_pins','King pins — play','Шкворні — люфт'),
  I('front_bearings','Front hubs / bearings — play','Передні ступиці / підшипники — люфт'),
  I('front_seals','Front wheel seals — leaks','Передні сальники коліс — витік')]},
 {id:'suspension',en:'4. Suspension / Springs',uk:'4. Підвіска / ресори',items:[
  I('front_springs','Front springs LH/RH — cracks / condition','Передні ресори LH/RH — тріщини / стан'),
  I('front_spring_bushings','Front spring bushings LH/RH','Бушинги передніх ресор LH/RH'),
  I('rear_bushings','Rear suspension / spring bushings','Бушинги задньої підвіски / ресор'),
  I('air_bags','Air bags — condition / leaks','Пневмоподушки — стан / витоки'),
  I('shocks','Shock absorbers','Амортизатори'),
  I('ubolts_torque','U-bolts / torque rods / bushings','U-болти / реактивні тяги / бушинги'),
  I('brackets_rideheight','Brackets / ride height / frame','Кронштейни / висота підвіски / рама')]},
 {id:'tires',en:'5. Tires / Wheels / Hubcaps',uk:'5. Шини / колеса / маточини',items:[
  I('steer_tires','Steer tires LH/RH — tread / damage / pressure','Передні шини LH/RH — протектор / пошкодження / тиск'),
  I('drive1_tires','Drive axle 1 tires — tread / pressure','Ведуча вісь 1 — шини / протектор / тиск'),
  I('drive2_tires','Drive axle 2 tires — tread / pressure','Ведуча вісь 2 — шини / протектор / тиск'),
  I('rims_lugs','Rims / lug nuts / studs','Диски / гайки / шпильки'),
  I('lh_hubcap','Front LH hubcap — oil level / leaks','Передня ліва маточина — рівень масла / витік'),
  I('rh_hubcap','Front RH hubcap — oil level / leaks','Передня права маточина — рівень масла / витік'),
  I('rear_seals','Rear wheel seals / hubcaps — leaks','Задні сальники / маточини — витоки')]},
 {id:'cab',en:'6. Cab / HVAC / Glass',uk:'6. Кабіна / клімат / скло',items:[
  I('cab_bushings','Cab bushings LH/RH','Бушинги кабіни LH/RH'),
  I('cab_shocks','Cab shocks LH/RH','Амортизатори кабіни LH/RH'),
  I('cab_mounts','Cab mounts / latches','Кріплення / замки кабіни'),
  I('windshield','Windshield — chips / cracks','Лобове скло — сколи / тріщини'),
  I('mirrors_doors_belts','Mirrors / doors / seat belts','Дзеркала / двері / ремені безпеки'),
  I('ac','A/C — cooling / compressor / operation','Кондиціонер — холод / компресор / робота'),
  I('heater','Heater — heat / blower / defroster','Пічка — нагрів / вентилятор / обдув скла'),
  I('wipers','Wipers / washer','Склоочисники / омивач')]},
 {id:'hoses_lights',en:'7. 3-in-1 / Hoses / Wiring / Lights',uk:'7. 3-in-1 / шланги / кабелі / світло',items:[
  I('three_in_one','3-in-1 — electrical cable / air lines / connectors','3-in-1 — кабель / повітряні лінії / розʼєми'),
  I('three_in_one_rub','3-in-1 — not rubbing anywhere','3-in-1 — ніде не треться'),
  I('all_hoses','All hoses — chafing / cracks / mounting','Всі шланги — потертості / тріщини / кріплення'),
  I('all_wiring','All wiring — chafing / exposed wires','Вся проводка — потертості / оголені дроти'),
  I('moving_clearance','Hoses / cables clear of driveshaft / exhaust / moving parts','Шланги / кабелі не торкаються кардана / вихлопу / рухомих частин'),
  I('lights','Headlights / marker / turn / brake lights','Фари / габарити / поворотники / стопи'),
  I('horn_warnings','Horn / warning lights','Клаксон / контрольні лампи')]},
 {id:'frame_transmission',en:'8. Fifth Wheel / Frame / Driveline',uk:'8. Сідло / рама / трансмісія',items:[
  I('fifth_wheel','Fifth wheel — jaws / lock / wear / cracks','Сідло — замок / знос / тріщини'),
  I('fifth_mount','Fifth wheel — mounting / lubrication','Сідло — кріплення / мастило'),
  I('frame','Frame / crossmembers — cracks / damage','Рама / поперечини — тріщини / пошкодження'),
  I('driveline','Driveshaft / U-joints / carrier bearing','Кардан / хрестовини / підвісний підшипник'),
  I('trans_diff_axles','Transmission / differential / axles — leaks','Коробка / диференціал / мости — витоки'),
  I('fuel_tanks','Fuel tanks / mounting / leaks','Паливні баки / кріплення / витоки')]},
 {id:'emissions',en:'9. DPF / DEF / Diagnostics',uk:'9. DPF / DEF / діагностика',items:[
  I('exhaust','Exhaust — leaks / mounting','Вихлоп — витоки / кріплення'),
  I('aftertreatment','DPF / DOC / SCR / DEF — visual condition','DPF / DOC / SCR / DEF — візуальний стан'),
  I('warning_lights','Check Engine / ABS / warning lights','Check Engine / ABS / контрольні лампи'),
  I('fault_codes','Active / stored fault codes','Активні / збережені коди несправностей')]},
 {id:'final',en:'10. Final Check / Road Test',uk:'10. Фінальна перевірка / тест-драйв',items:[
  I('oil_temp','Oil pressure / engine temperature','Тиск оливи / температура двигуна'),
  I('air_pressure','Air pressure build-up and hold','Набір та утримання тиску повітря'),
  I('road_brakes_steering','Brakes / steering on road test','Гальма / рульове керування'),
  I('shifting','Transmission / shifting','Коробка передач / перемикання'),
  I('vibration_noise','Vibration / unusual noise','Вібрації / сторонні шуми'),
  I('engine_brake_cruise','Engine brake / cruise control','Моторне гальмо / круїз-контроль'),
  I('post_drive_leaks','Leak re-check after road test','Повторна перевірка витоків після тест-драйву')]}
].map(S);
const TRAILER_SECTIONS=[
 {id:'frame',en:'1. Frame / Body / Landing Gear',uk:'1. Рама / кузов / опори',items:[
  I('main_rails','Main rails — cracks / bends / corrosion','Рама — тріщини / вигини / корозія'),
  I('crossmembers','Crossmembers','Поперечини'),
  I('nose','Front wall / nose','Передня стінка'),
  I('side_panels','Side panels','Бокові стінки'),
  I('roof','Roof — damage / leaks','Дах — пошкодження / протікання'),
  I('floor','Floor — cracks / holes','Підлога — тріщини / отвори'),
  I('icc_bumper','ICC bumper / rear impact guard','Задній відбійник (ICC)'),
  I('landing_gear','Landing gear — legs / crank / gearbox','Опори — ноги / ручка / редуктор'),
  I('kingpin','Kingpin / upper coupler plate','Шкворень / плита зчеплення'),
  I('mudflaps','Mud flaps / brackets','Бризговики / кронштейни')]},
 {id:'brakes',en:'2. Brakes',uk:'2. Гальма',items:[
  I('axle1_lh_brake','Axle 1 LH — brake linings / drum or rotor','Вісь 1 ліва — колодки / барабан або ротор'),
  I('axle1_rh_brake','Axle 1 RH — brake linings / drum or rotor','Вісь 1 права — колодки / барабан або ротор'),
  I('axle2_lh_brake','Axle 2 LH — brake linings / drum or rotor','Вісь 2 ліва — колодки / барабан або ротор'),
  I('axle2_rh_brake','Axle 2 RH — brake linings / drum or rotor','Вісь 2 права — колодки / барабан або ротор'),
  I('slack_chambers','Slack adjusters / brake chambers','Регулятори (slack) / гальмівні камери'),
  I('scams','S-cams / bushings / rollers','S-кулачки / втулки / ролики'),
  I('air_hoses','Air lines / hoses / fittings','Повітряні лінії / шланги / фітинги'),
  I('air_leaks','Air leaks','Витоки повітря'),
  I('abs','ABS — lamp / sensors / wiring','ABS — лампа / датчики / проводка')]},
 {id:'suspension',en:'3. Suspension / Axles',uk:'3. Підвіска / осі',items:[
  I('air_bags','Air bags — cracks / leaks','Пневмоподушки — тріщини / витоки'),
  I('shocks','Shock absorbers','Амортизатори'),
  I('torque_rods','Torque rods / bushings','Реактивні тяги / бушинги'),
  I('spring_bushings','Spring / suspension bushings','Бушинги ресор / підвіски'),
  I('ubolts','U-bolts / mounting','U-болти / кріплення'),
  I('axles','Axles — cracks / damage','Осі — тріщини / пошкодження'),
  I('hangers','Hangers / brackets','Кронштейни підвіски'),
  I('ride_height','Ride height / leveling valve','Висота підвіски / клапан рівня'),
  I('slider','Slider rails / pins / locks','Слайдер — рейки / пальці / фіксатори')]},
 {id:'tires',en:'4. Tires / Wheels / Hubcaps',uk:'4. Шини / колеса / маточини',items:[
  I('axle1_lh_tires','Axle 1 LH inner/outer — tread / pressure / damage','Вісь 1 ліва внутр./зовн. — протектор / тиск / пошкодження'),
  I('axle1_rh_tires','Axle 1 RH inner/outer — tread / pressure / damage','Вісь 1 права внутр./зовн. — протектор / тиск / пошкодження'),
  I('axle2_lh_tires','Axle 2 LH inner/outer — tread / pressure / damage','Вісь 2 ліва внутр./зовн. — протектор / тиск / пошкодження'),
  I('axle2_rh_tires','Axle 2 RH inner/outer — tread / pressure / damage','Вісь 2 права внутр./зовн. — протектор / тиск / пошкодження'),
  I('rims','Rims','Диски'),
  I('lug_nuts','Lug nuts / studs','Гайки / шпильки'),
  I('hubcaps','Hubcaps — oil level / leaks','Маточини — рівень масла / витоки'),
  I('wheel_seals','Wheel seals — leaks','Сальники коліс — витоки'),
  I('wheel_bearings','Wheel bearings — play / noise','Підшипники коліс — люфт / шум')]},
 {id:'electric',en:'5. Air / Electrical / Lights',uk:'5. Повітря / електрика / світло',items:[
  I('seven_way','7-way electrical plug / cable','7-контактна розетка / кабель'),
  I('service_air','Service air line / gladhand','Службова повітряна лінія / gladhand'),
  I('emergency_air','Emergency air line / gladhand','Аварійна повітряна лінія / gladhand'),
  I('line_rubbing','Air lines / cable — not rubbing anywhere','Повітряні лінії / кабель — ніде не труться'),
  I('under_wiring','Under-trailer wiring — chafing / mounting','Проводка під трейлером — потертості / кріплення'),
  I('marker_lights','Marker / clearance lights','Габаритні вогні'),
  I('turn_stop_tail','Turn / stop / tail lights','Поворотники / стопи / задні вогні'),
  I('plate_light','License plate light','Підсвітка номера'),
  I('abs_light','ABS light','Лампа ABS')]},
 {id:'doors',applies:['dry_van','reefer'],en:'6. Dry Van / Reefer — Doors and Interior',uk:'6. Dry Van / Reefer — двері та внутрішній стан',items:[
  I('rear_doors','Rear doors — hinges / locks / rods','Задні двері — петлі / замки / штанги'),
  I('door_seals','Door seals','Ущільнювачі дверей'),
  I('door_operation','Doors open / close properly','Двері правильно відкриваються / закриваються'),
  I('inside_walls','Interior walls / scuff liner','Внутрішні стіни / захисна обшивка'),
  I('inside_floor','Interior floor','Підлога всередині'),
  I('inside_roof','Roof from inside — signs of leaks','Дах зсередини — сліди протікання'),
  I('cargo_rails','Cargo rails / E-track','Вантажні рейки / E-track')]},
 {id:'reefer',applies:['reefer'],en:'7. Reefer Unit (if equipped)',uk:'7. Рефустановка (якщо є)',items:[
  I('reefer_run','Reefer unit — start / operation / noise','Рефустановка — запуск / робота / шуми'),
  I('reefer_oil','Engine oil — level / leaks','Моторна олива — рівень / витоки'),
  I('reefer_coolant','Coolant — level / leaks','Антифриз — рівень / витоки'),
  I('reefer_belts','Belts / tensioners','Ремені / натягувачі'),
  I('reefer_battery','Battery / terminals','Акумулятор / клеми'),
  I('reefer_fuel_lines','Fuel tank / lines — leaks','Паливний бак / лінії — витоки'),
  I('reefer_fuel_level','Reefer fuel level','Рівень палива рефустановки'),
  I('reefer_condenser','Condenser / radiator','Конденсатор / радіатор'),
  I('reefer_evaporator','Evaporator / fans','Випарник / вентилятори'),
  I('reefer_temp','Reaches set temperature','Набирає задану температуру'),
  I('reefer_codes','Controller / fault codes','Контролер / коди несправностей'),
  I('reefer_drains','Drain tubes / seals','Дренажні трубки / ущільнення')]},
 {id:'conestoga',applies:['conestoga'],en:'8. Conestoga — Tarp / Mechanism',uk:'8. Conestoga — тент / механізм',items:[
  I('tarp','Tarp — cuts / holes / wear','Тент — порізи / дірки / потертості'),
  I('tarp_seals','Front / rear tarp seals','Переднє / заднє ущільнення тенту'),
  I('roof_bows','Roof bows','Арки даху'),
  I('rollers','Carriages / rollers','Каретки / ролики'),
  I('rails','Rails / tracks','Рейки / направляючі'),
  I('locking','Locking mechanism / handles','Замковий механізм / ручки'),
  I('rear_frame','Rear frame / bulkhead','Задня рама / перегородка'),
  I('front_bulkhead','Front bulkhead','Передня перегородка'),
  I('open_close','Tarp fully opens / closes','Тент повністю відкривається / закривається'),
  I('straps','Straps / buckles','Ремені / пряжки'),
  I('water_leaks','Water leaks / seals','Протікання води / ущільнення')]},
 {id:'final',en:'9. Final Check',uk:'9. Фінальна перевірка',items:[
  I('grease','Grease points / lubrication','Точки змащення / змащення'),
  I('connected_air_leaks','Air leaks after hook-up','Витоки повітря після підключення'),
  I('all_lights','All lights after hook-up','Все світло після підключення'),
  I('abs_self','ABS self-check','Самоперевірка ABS'),
  I('slider_locked','Slider pins locked','Пальці слайдера заблоковані'),
  I('landing_up','Landing gear raised','Опори підняті'),
  I('doors_locks','Doors / Conestoga locks closed','Двері / замки Conestoga закриті'),
  I('hubcaps_recheck','Hubcaps / wheel seals re-check','Повторна перевірка маточин / сальників')]}
].map(S);
function sectionsFor(inspection){const i=inspection||{};if(i.type==='truck')return TRUCK_SECTIONS;const subtype=String(i.subtype||'');return TRAILER_SECTIONS.filter(s=>!s.applies||s.applies.includes(subtype))}
function itemsFor(inspection){return sectionsFor(inspection).flatMap(s=>s.items.map(item=>({...item,sectionId:s.id,sectionTitle:s.title})))}
function text(obj,lang){if(!obj)return '';return String(lang)==='uk'?(obj.uk||obj.en||obj.label||obj.title||''):(obj.en||obj.label||obj.title||'')}
root.ITTRInspectionChecklist=Object.freeze({TRUCK_SECTIONS,TRAILER_SECTIONS,sectionsFor,itemsFor,text});
})(typeof window!=='undefined'?window:globalThis);
