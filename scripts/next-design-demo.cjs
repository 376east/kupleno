const {chromium}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const output=process.env.KUPLENO_DESIGN_OUTPUT;
if(!output)throw new Error('Set KUPLENO_DESIGN_OUTPUT');
const record=process.argv.includes('--record');
const products=[['Кроссовки для города','Одежда',7490],['Наушники Nothing Ear','Электроника',9990],['Лампа для рабочего стола','Дом',2490],['Худи oversize','Одежда',3290],['Книга «Искусство замечать»','Книги',890],['Коврик для йоги','Спорт',1590],['Плёнка Kodak Gold 200','Хобби',1790],['Рюкзак для поездок','Одежда',4290],['Кружка из керамики','Дом',790],['Механическая клавиатура','Электроника',6490],['Настольная игра','Хобби',2490],['Бутылка для воды','Спорт',990]];
(async()=>{
 await fs.mkdir(output,{recursive:true});
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'kupleno-design-'));
 const build=path.resolve(__dirname,'../extension/next/.output/chrome-mv3');
 const ctx=await chromium.launchPersistentContext(profile,{headless:true,channel:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?undefined:'chromium',executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:[`--disable-extensions-except=${build}`,`--load-extension=${build}`],viewport:{width:1440,height:1000},deviceScaleFactor:1,...record?{recordVideo:{dir:output,size:{width:1440,height:1000}}}:{}});
 let video;
 try{
 const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));video=page.video();
 await page.goto(`chrome-extension://${id}/app.html`);
 await page.getByRole('heading',{name:/Покупки складываются/}).waitFor();await page.evaluate(()=>document.fonts.ready);
 async function shot(name){await page.screenshot({path:path.join(output,name+'.png'),fullPage:true,animations:'disabled'});}
 async function caption(text){if(!record)return;await page.evaluate(text=>{let el=document.getElementById('demo-caption');if(!el){el=document.createElement('div');el.id='demo-caption';Object.assign(el.style,{position:'fixed',bottom:'18px',left:'50%',transform:'translateX(-50%)',zIndex:'100',background:'#202027',color:'#fff',padding:'14px 25px',border:'1px solid #54515e',borderRadius:'16px',font:'14px Golos,Arial',boxShadow:'0 8px 35px #0003',whiteSpace:'nowrap',pointerEvents:'none'});document.body.append(el);}el.textContent=text;},text);}
 async function pause(n=2000){if(record)await page.waitForTimeout(n);}
 await caption('Куплено / 0.21 · Демонстрационные данные');await pause(3200);await shot('01-welcome-light');
 const rows=Array.from({length:36},(_,i)=>{const p=products[i%products.length];return{rowId:`demo-${i}`,source:['ozon','wildberries','yandex'][i%3],date:`2026-${String(4+Math.floor(i/6)).padStart(2,'0')}-${String(3+i%23).padStart(2,'0')}`,title:p[0],category:p[1],amount:String(p[2]),currency:'RUB',type:'purchase',profile:'personal',marketplace_id:`DEMO-${i}`,parse_quality:'complete'};});
 rows.push({rowId:'demo-refund',source:'wildberries',date:'2026-09-25',title:'Возврат: худи oversize',category:'Одежда',amount:'-3290',currency:'RUB',type:'refund',profile:'personal'});
 const fixture={format:'kupleno-backup',version:1,rows,settings:{profiles:[{id:'personal',name:'Личные'}],overrides:{},customRules:[],refundClaims:[],warranties:[]},metadata:{demo:true}};
 await page.locator('input[type=file]').first().setInputFiles({name:'demo.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
 await page.getByRole('dialog').getByRole('button',{name:'Загрузить историю',exact:true}).click();await page.getByRole('heading',{name:'Обзор',exact:true}).waitFor();
 await caption('01 / Вся история — один взгляд');await pause(4000);await shot('02-overview-light');
 const headingBefore=await page.locator('.page-heading').boundingBox();await page.locator('.overview-filters summary').click();await pause(1600);assert.deepEqual(await page.locator('.page-heading').boundingBox(),headingBefore);await page.locator('.overview-filters summary').click();
 await page.getByRole('button',{name:'Включить тёмную тему',exact:true}).click();await caption('02 / Тёмная тема. Та же система.');await pause(2300);if(record){await page.evaluate(()=>window.scrollTo({top:420,behavior:'smooth'}));await pause(2300);await page.evaluate(()=>window.scrollTo({top:0,behavior:'smooth'}));await pause(600);}await shot('03-overview-dark');
 await page.getByRole('link',{name:'Покупки',exact:true}).click();await caption('03 / Найти вещь. Открыть детали.');await page.getByRole('searchbox').pressSequentially('Кроссовки',{delay:record?110:0});await pause(1700);await shot('04-search-dark');
 await page.getByRole('button',{name:'Кроссовки для города',exact:true}).first().click();await pause(2500);await shot('05-details-dark');await page.getByRole('button',{name:'Закрыть',exact:true}).click();
 await page.getByRole('link',{name:'Магазины',exact:true}).click();await caption('04 / Три магазина. Покупки и чеки рядом.');await pause(3000);await shot('06-stores-dark');
 await page.getByRole('link',{name:'Контроль',exact:true}).click();await caption('05 / Бюджет, возвраты и гарантии');await pause(2800);await shot('07-control-dark');
 await page.getByRole('link',{name:'Настройки',exact:true}).click();await shot('08-settings-dark');
 if(!record) for(const theme of ['dark','light']){
 if(theme==='light')await page.getByRole('button',{name:'Включить светлую тему',exact:true}).click();
 await page.setViewportSize({width:390,height:844});
 for(const section of ['Обзор','Покупки','Магазины','Контроль','Настройки']){
 await page.getByRole('link',{name:section,exact:true}).click();
 const overflow=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).map(el=>({tag:el.tagName,cls:el.className,width:el.getBoundingClientRect().width,text:el.textContent.slice(0,65)})).slice(0,8)); if(overflow.length)console.log(JSON.stringify({section,theme,overflow})); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${section} ${theme} overflow`);
 if(section==='Обзор'||section==='Магазины')await shot(`mobile-${section==='Обзор'?'overview':'stores'}-${theme}`);
 }
 }
 if(!record){await page.setViewportSize({width:320,height:780});await page.getByRole('link',{name:'Контроль',exact:true}).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'320px control overflow');}
 if(!record){
 const profilesFixture={...fixture,rows:fixture.rows.map(row=>({...row,profile:'work'})),settings:{...fixture.settings,profiles:[{id:'personal',name:'Личные'},{id:'work',name:'Работа'}],budgets:{'work\u00012026-10':{total:5000}},monthClosures:{'work\u00012026-09':{status:'closed'}}}};
 await page.locator('input[type=file]').first().setInputFiles({name:'profiles.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(profilesFixture))});
 await page.getByRole('dialog').getByRole('button',{name:'Загрузить историю',exact:true}).click();
 await page.getByRole('link',{name:'Настройки',exact:true}).click();
 for(const theme of ['light','dark']) for(const width of [390,1440]){
 if(await page.locator('html').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:theme==='dark'?'Включить тёмную тему':'Включить светлую тему',exact:true}).click();
 await page.setViewportSize({width,height:width===390?844:1000});
 await page.getByRole('button',{name:'Настроить профили',exact:true}).click();
 await page.getByRole('dialog').locator('.setting-row').filter({has:page.getByText('Работа',{exact:true})}).getByRole('button',{name:'Объединить с другим',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Объединить профили?',exact:true});await dialog.waitFor();
 const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1,'Profile confirmation must fit viewport');
 assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'Profile confirmation content must not overflow');
 await shot(`profile-merge-${width}-${theme}`);
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 }
 await page.evaluate(async()=>{
 const db=await new Promise(resolve=>{const r=indexedDB.open('kupleno-storage-v2');r.onsuccess=()=>resolve(r.result);});
 try{const tx=db.transaction('current','readwrite'),store=tx.objectStore('current');const record=await new Promise(resolve=>{const r=store.get('state');r.onsuccess=()=>resolve(r.result);});record.state.settings.customRules=[{category:{broken:true}}];store.put(record);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{db.close();}
 });
 await page.reload();await page.getByRole('heading',{name:'Восстановить историю',exact:true}).waitFor();
 for(const theme of ['light','dark'])for(const width of [390,1440]){
 if(await page.locator('html').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:theme==='dark'?'Включить тёмную тему':'Включить светлую тему',exact:true}).click();
 await page.setViewportSize({width,height:width===390?844:1000});await page.evaluate(()=>window.scrollTo(0,0));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Recovery overflow');
 await shot(`recovery-${width}-${theme}`);
 }
 await page.locator('input[type=file]').first().setInputFiles({name:'valid.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});await page.getByRole('dialog').getByRole('button',{name:'Загрузить историю',exact:true}).click();await page.getByRole('heading',{name:'Обзор',exact:true}).waitFor();
 }
 await page.setViewportSize({width:1440,height:1000});await page.getByRole('link',{name:'Обзор',exact:true}).click();
 // Clear the search set in purchases; overview shares the same filters by design.
 await page.locator('.overview-filters summary').click();await page.getByRole('searchbox').fill('');await page.locator('.overview-filters summary').click();
 await caption('Куплено · Все вещи на своих местах.');await pause(3500);
 assert.deepEqual(errors,[]);console.log('PASS: light/dark, 5 mobile pages without overflow, stable filter heading, search/details/store/control flows; synthetic data only.');
 }finally{const recordedPath=record&&video?await video.path():null;await ctx.close();if(recordedPath)await fs.copyFile(recordedPath,path.join(output,'kupleno-demo.webm'));assert.equal(path.dirname(profile),os.tmpdir());assert.ok(path.basename(profile).startsWith('kupleno-design-'));await fs.rm(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
