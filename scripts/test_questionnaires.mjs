import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../api/_lib/questionnaires.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const questionnaires = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const list = questionnaires.listQuestionnaires();
assert(list.length > 0, 'questionnaire catalogue must not be empty');
assert(list.some((item) => item.key === 'product-data-core' && item.version === '1.0'), 'versioned core questionnaire is missing');

const template = questionnaires.getQuestionnaire('product-data-core', '1.0');
assert(template && template.items.length >= 4, 'core questionnaire items are missing');
const percentageItem = template.items.find((item) => item.fieldKey === 'main_material_percentage');
const compositionItem = template.items.find((item) => item.fieldKey === 'material_composition');
assert(percentageItem && questionnaires.validateResponseValue(percentageItem, 45) === null, 'valid percentage was rejected');
assert(percentageItem && questionnaires.validateResponseValue(percentageItem, 145) === 'response_value_above_maximum', 'invalid percentage was accepted');
assert(compositionItem && questionnaires.validateResponseValue(compositionItem, [{ materialKey: 'cotton', percentage: 100 }]) === null, 'valid composition was rejected');
assert(compositionItem && questionnaires.validateResponseValue(compositionItem, { materialKey: 'cotton' }) === 'response_value_shape_invalid', 'invalid composition shape was accepted');

console.log('Questionnaire contract passed: catalogue, immutable version and response validation');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
