import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

const ingredients=Array.from({length:6},(_,i)=>({name:`Ingredient ${i+1}`,quantity:'1 cup',category:'Other'}));
const recipes=[
  {id:1,title:'QA Cooking Map — skillet sausage casserole with roasted vegetables',notes:'Mix and bake.',ingredients,source:'native',meal_types:['dinner']},
  {id:2,title:'Provider recipe with a long descriptive name and separate side dishes',notes:'Prepare and serve.',ingredients,source:'mealie',provider_account_id:1,provider_has_image:false,meal_types:['dinner']},
];
const app=express();
app.use('/api/v1',(req,res)=>{
  if(req.path==='/recipes')return res.json({data:recipes});
  if(req.path==='/meals')return res.json({data:[{recipe_id:1,date:new Date().toISOString().slice(0,10)}]});
  if(req.path==='/preferences')return res.json({data:{language:'en',date_format:'mdy'}});
  return res.json({data:[]});
});
const styles=[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag])=>tag).join('');
app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
app.get('/recipe-row-fixture',(_req,res)=>res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<link rel="stylesheet" href="/styles/list-row.css"><link rel="stylesheet" href="/styles/recipes.css"></head><body><main id="main-content"></main></body></html>`));
let server,browser,base;
test.before(async()=>{
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'&&existsSync(edge)?edge:undefined),args:['--no-sandbox']});
});
test.after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve)||resolve());});

for(const width of [1366,768,550,390])test(`recipe titles retain their row and native/provider actions at ${width}px`,async()=>{
  const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.setViewport({width,height:900});await page.goto(`${base}/recipe-row-fixture`);
    await page.evaluate(async()=>{
      const {initI18n,setLocale}=await import('/i18n.js');await initI18n();await setLocale('en');
      window.yuvomi={user:{id:1,role:'admin'},navigate(){},showToast(){},isModuleDisabled(){return false;}};
      const {render}=await import('/pages/recipes.js');await render(document.querySelector('main'));
    });
    for(const theme of ['light','dark']){
      await page.evaluate(theme=>Object.assign(document.documentElement.dataset,{theme,colorTheme:'warm',typography:'serif'}),theme);
      const rows=await page.$$eval('.recipe-row',rows=>rows.map(row=>{
        const rect=selector=>{const r=row.querySelector(selector).getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};};
        return{rowWidth:row.getBoundingClientRect().width,name:rect('.list-row__name'),meta:rect('.list-row__meta'),actions:rect('.list-row__actions'),inline:!!row.querySelector('.recipe-row__inline-actions').getClientRects().length,more:!!row.querySelector('.recipe-row__more').getClientRects().length,buttons:[...row.querySelectorAll('.recipe-row__inline-actions button')].map(button=>button.dataset.action),overflow:document.documentElement.scrollWidth>innerWidth};
      }));
      assert.equal(rows.length,2);
      rows.forEach((row,index)=>{
        assert.equal(row.overflow,false);
        assert.ok(row.name.width>row.rowWidth*(index===0?.75:.65),'title keeps useful width');
        assert.ok(row.name.bottom<=row.meta.top,'ingredient summary appears below the title');
        assert.ok(row.meta.bottom<=row.actions.top,'actions appear below the summary');
        assert.equal(row.more,!row.inline,'exactly one action presentation is visible');
        assert.deepEqual(row.buttons,index===0?['pipeline','edit','export-markdown','duplicate','delete']:['pipeline','export-markdown','duplicate']);
      });
    }
    await page.click('.recipe-row__toggle[data-id="1"]');
    assert.equal(await page.$eval('.recipe-row__toggle[data-id="1"]',node=>node.getAttribute('aria-expanded')),'true');
    assert.match(await page.$eval('#recipes-list',node=>node.innerText),/Ingredient 1/);
    if(width===390){
      await page.click('[popovertarget="recipe-menu-1"]');
      await page.waitForSelector('#recipe-menu-1:popover-open');
      assert.deepEqual(await page.$$eval('#recipe-menu-1 button',buttons=>buttons.map(button=>button.dataset.action)),['pipeline','edit','export-markdown','duplicate','delete']);
      await page.keyboard.press('Escape');
      assert.equal(await page.$('#recipe-menu-1:popover-open'),null);
    }
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
