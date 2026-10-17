import test from 'node:test';
import assert from 'node:assert/strict';
import {CARD_SLOTS,defaultNamedAppearance,resolveNamedAppearance,cardColor,mixColors,contrastRatio} from '../public/utils/named-appearance.js';

// A 90% tinted card can sit over any photographic pixel, including clear night.
// Test every ink/slot against both photographic extremes, not an average image.
for(const condition of ['rain','snow','sunny','cloudy','storm'])for(const is_day of [true,false])test(`translucent weather card inks remain readable: ${condition} ${is_day?'day':'night'}`,()=>{
  const now=new Date(),theme=resolveNamedAppearance({...defaultNamedAppearance(),theme:'local-weather'},now,{condition,is_day,observed_at:now.toISOString(),fetched_at:now.toISOString(),expires_at:new Date(+now+3600000).toISOString(),sunrise_at:null,sunset_at:null}).theme;
  for(const slot of CARD_SLOTS){const color=cardColor(theme,slot);for(const backdrop of ['#000000','#ffffff'])for(const role of ['text','muted','danger','success','warning','info']){
    const contrast=contrastRatio(color[role],mixColors(color.fill,backdrop,.1));
    assert.ok(contrast>=4.5,`${slot} ${role} must retain AA contrast over ${backdrop}: ${contrast}`);
  }}
});
