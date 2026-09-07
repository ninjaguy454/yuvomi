// Authored examples: fixtures never infer operations or ingredient quantities.
const ingredient = (id, name, quantity, source_index) => ({ id, kind: 'ingredient', name, quantity, source_index });
const component = (id, name, quantity = '') => ({ id, kind: 'component', name, quantity, source_index: null });
const readiness = (id, name) => ({ id, kind: 'readiness', name, quantity: '', source_index: null });
const operation = (id, label, consumes, produces, options = {}) => ({
  id, label, consumes, requires: [], equipment: [], produces,
  duration: null, temperature: null, ...options,
});
const minutes = (min, max = min) => ({ min_seconds: min * 60, max_seconds: max * 60 });

function fixture(title, resources, operations, notes) {
  return {
    recipe: {
      title,
      notes,
      ingredients: resources.filter(resource => resource.kind === 'ingredient').map(resource => ({ name: resource.name, quantity: resource.quantity })),
    },
    pipeline: { schema_version: 1, resources, operations },
  };
}

export const bananaBread = fixture('Banana bread with explicit preparation branches', [
  ingredient('bananas', 'Ripe bananas', '2 large', 0),
  ingredient('butter', 'Butter', '90 g', 1),
  ingredient('vanilla', 'Vanilla extract', '1 tsp', 2),
  ingredient('eggs', 'Eggs', '2 large', 3),
  ingredient('flour', 'All-purpose flour', '180 g', 4),
  ingredient('sugar', 'Sugar', '130 g', 5),
  ingredient('soda', 'Baking soda', '1/2 tsp', 6),
  ingredient('powder', 'Baking powder', '1/2 tsp', 7),
  ingredient('salt', 'Salt', '1/2 tsp', 8),
  ingredient('walnuts', 'Walnuts', '70 g', 9),
  component('butter-pan', 'Butter for the pan', '10 g'),
  component('butter-batter', 'Butter for the batter', '80 g'),
  component('flour-pan', 'Flour for the pan', '10 g'),
  component('flour-batter', 'Flour for the batter', '170 g'),
  readiness('oven-ready', 'Oven heated to 350°F'),
  readiness('pan-ready', 'Buttered and floured loaf pan'),
  component('mashed-bananas', 'Mashed bananas'),
  component('melted-butter', 'Melted butter'),
  component('beaten-eggs', 'Beaten eggs'),
  component('dry-mixture', 'Dry mixture'),
  component('wet-mixture', 'Wet mixture'),
  component('batter', 'Banana bread batter'),
  component('filled-pan', 'Filled loaf pan'),
  component('hot-loaf', 'Baked banana bread'),
  component('warm-loaf', 'Banana bread cooled in its pan'),
  component('cooled-loaf', 'Cooled banana bread'),
], [
  operation('preheat', 'Preheat the oven', [], ['oven-ready'], { equipment: ['Oven'], temperature: { value: 350, unit: 'F' } }),
  operation('divide-butter', 'Divide the butter', ['butter'], ['butter-pan', 'butter-batter']),
  operation('divide-flour', 'Divide the flour', ['flour'], ['flour-pan', 'flour-batter']),
  operation('prepare-pan', 'Butter and flour the loaf pan', ['butter-pan', 'flour-pan'], ['pan-ready'], { equipment: ['Loaf pan'] }),
  operation('mash', 'Mash the bananas', ['bananas'], ['mashed-bananas'], { equipment: ['Bowl', 'Fork'], duration: minutes(3) }),
  operation('melt', 'Melt the butter', ['butter-batter'], ['melted-butter'], { equipment: ['Saucepan'] }),
  operation('beat', 'Lightly beat the eggs', ['eggs'], ['beaten-eggs'], { equipment: ['Bowl', 'Whisk'] }),
  operation('whisk', 'Whisk the dry ingredients', ['flour-batter', 'sugar', 'soda', 'powder', 'salt'], ['dry-mixture'], { equipment: ['Bowl', 'Whisk'], duration: minutes(2) }),
  operation('mix-wet', 'Mix the wet ingredients until smooth', ['mashed-bananas', 'melted-butter', 'beaten-eggs', 'vanilla'], ['wet-mixture']),
  operation('fold', 'Fold wet and dry mixtures together with walnuts', ['wet-mixture', 'dry-mixture', 'walnuts'], ['batter']),
  operation('fill-pan', 'Pour the batter into the prepared pan', ['batter'], ['filled-pan'], { requires: ['pan-ready'], equipment: ['Loaf pan'] }),
  operation('bake', 'Bake the banana bread', ['filled-pan'], ['hot-loaf'], { requires: ['oven-ready'], equipment: ['Oven', 'Loaf pan'], duration: minutes(55, 65), temperature: { value: 350, unit: 'F' } }),
  operation('cool-pan', 'Cool in the pan', ['hot-loaf'], ['warm-loaf'], { equipment: ['Loaf pan'], duration: minutes(10) }),
  operation('cool-rack', 'Cool completely on a wire rack', ['warm-loaf'], ['cooled-loaf'], { equipment: ['Wire rack'] }),
], 'Preheat the oven to 350°F. Reserve 10 g butter and 10 g flour for the loaf pan. Butter and flour the pan. Mash bananas; melt the remaining butter; lightly beat eggs. Whisk the remaining flour, sugar, soda, baking powder and salt. Mix bananas, butter, eggs and vanilla until smooth. Fold the dry mixture and walnuts into the wet mixture. Pour into the prepared pan. Bake for 55–65 minutes. Cool in the pan for 10 minutes, then cool completely on a wire rack.');

export const sequential = fixture('Simple sequential carrots', [
  ingredient('carrots', 'Carrots', '3', 0),
  component('washed', 'Washed carrots'),
  component('chopped', 'Chopped carrots'),
  component('cooked', 'Steamed carrots'),
], [
  operation('wash', 'Wash the carrots', ['carrots'], ['washed']),
  operation('chop', 'Chop the carrots', ['washed'], ['chopped'], { equipment: ['Knife'] }),
  operation('steam', 'Steam until tender', ['chopped'], ['cooked'], { equipment: ['Steamer'], duration: minutes(8, 10) }),
], 'Wash carrots. Chop the washed carrots. Steam for 8–10 minutes until tender.');

export const dough = fixture('Rested and risen bread dough', [
  ingredient('flour', 'Flour', '500 g', 0),
  ingredient('water', 'Water', '325 ml', 1),
  ingredient('yeast', 'Yeast', '7 g', 2),
  component('mixed', 'Mixed dough'),
  component('kneaded', 'Kneaded dough'),
  component('rested', 'Rested dough'),
  component('shaped', 'Shaped dough'),
  component('risen', 'Risen dough'),
  readiness('oven-ready', 'Oven heated to 220°C'),
  component('bread', 'Baked bread'),
], [
  operation('mix', 'Combine the ingredients', ['flour', 'water', 'yeast'], ['mixed']),
  operation('knead', 'Knead until elastic', ['mixed'], ['kneaded'], { duration: minutes(8, 12) }),
  operation('rest', 'Rest the dough', ['kneaded'], ['rested'], { duration: minutes(30) }),
  operation('shape', 'Shape the loaf', ['rested'], ['shaped']),
  operation('rise', 'Let rise until doubled', ['shaped'], ['risen']),
  operation('preheat', 'Preheat the oven', [], ['oven-ready'], { equipment: ['Oven'], temperature: { value: 220, unit: 'C' } }),
  operation('bake', 'Bake the risen loaf', ['risen'], ['bread'], { requires: ['oven-ready'], equipment: ['Oven'], duration: minutes(30, 35), temperature: { value: 220, unit: 'C' } }),
], 'Combine flour, water and yeast. Knead for 8–12 minutes until elastic. Rest for 30 minutes, shape and let rise until doubled. Preheat the oven to 220°C. Bake the risen loaf for 30–35 minutes.');

export const stovetopAndOven = fixture('Roasted carrots with stovetop rice', [
  ingredient('carrots', 'Carrots', '4', 0),
  ingredient('rice', 'Rice', '150 g', 1),
  ingredient('water', 'Water', '300 ml', 2),
  readiness('oven-ready', 'Oven heated to 200°C'),
  component('cut-carrots', 'Chopped carrots'),
  component('roasted-carrots', 'Roasted carrots'),
  component('cooked-rice', 'Cooked rice'),
  component('dish', 'Rice with roasted carrots'),
], [
  operation('preheat', 'Preheat the oven', [], ['oven-ready'], { equipment: ['Oven'], temperature: { value: 200, unit: 'C' } }),
  operation('chop', 'Chop the carrots', ['carrots'], ['cut-carrots'], { equipment: ['Knife'] }),
  operation('roast', 'Roast the carrots', ['cut-carrots'], ['roasted-carrots'], { requires: ['oven-ready'], equipment: ['Oven', 'Baking tray'], duration: minutes(25), temperature: { value: 200, unit: 'C' } }),
  operation('cook-rice', 'Cook the rice on the stove', ['rice', 'water'], ['cooked-rice'], { equipment: ['Saucepan', 'Stove'], duration: minutes(20) }),
  operation('combine', 'Combine rice and roasted carrots', ['roasted-carrots', 'cooked-rice'], ['dish']),
], 'Preheat the oven to 200°C. Chop and roast carrots for 25 minutes. Cook rice with water in a saucepan for 20 minutes. Combine cooked rice and roasted carrots.');

export const separateSauce = fixture('Pasta with a separately prepared sauce', [
  ingredient('pasta', 'Pasta', '200 g', 0),
  ingredient('tomatoes', 'Tomatoes', '400 g', 1),
  ingredient('onion', 'Onion', '1', 2),
  component('cooked-pasta', 'Cooked pasta'),
  component('chopped-onion', 'Chopped onion'),
  component('sauce', 'Tomato sauce'),
  component('finished', 'Pasta with tomato sauce'),
], [
  operation('cook-pasta', 'Cook the pasta', ['pasta'], ['cooked-pasta'], { equipment: ['Pot', 'Stove'], duration: minutes(10) }),
  operation('chop-onion', 'Chop the onion', ['onion'], ['chopped-onion'], { equipment: ['Knife'] }),
  operation('simmer-sauce', 'Simmer tomatoes and onion', ['tomatoes', 'chopped-onion'], ['sauce'], { equipment: ['Saucepan', 'Stove'], duration: minutes(15) }),
  operation('combine', 'Toss pasta with the sauce', ['cooked-pasta', 'sauce'], ['finished']),
], 'Cook pasta for 10 minutes. In a separate saucepan, simmer chopped onion with tomatoes for 15 minutes. Toss the cooked pasta with the sauce.');

export const cooling = fixture('Cooked custard with cooling and resting stages', [
  ingredient('custard', 'Prepared custard mixture', '500 ml', 0),
  component('cooked', 'Cooked custard'),
  component('cooled', 'Cooled custard'),
  component('chilled', 'Chilled custard'),
], [
  operation('cook', 'Cook the custard until thickened', ['custard'], ['cooked'], { equipment: ['Saucepan'] }),
  operation('cool', 'Cool the custard', ['cooked'], ['cooled'], { duration: minutes(20, 30) }),
  operation('chill', 'Chill until set', ['cooled'], ['chilled'], { equipment: ['Refrigerator'], duration: minutes(120) }),
], 'Cook the custard until thickened. Cool for 20–30 minutes. Refrigerate for 2 hours until set.');

export const recipePipelineFixtures = { bananaBread, sequential, dough, stovetopAndOven, separateSauce, cooling };
