import test from 'node:test'
import assert from 'node:assert/strict'
import { newRecipe, recipeErrors, dockerfileFor, storedRecipe } from './image-templates.js'
const id = 'abcdefabcdefabcdefabcdef'
test('setup image recipes store only pinned IDs and add offline bundles with Python', () => {
  const recipe = newRecipe({ name:'setup-test',agents:[],setups:[id],command:'' })
  assert.deepEqual(recipeErrors(recipe),{})
  const file=dockerfileFor(recipe)
  assert.match(file,/python3/)
  assert.match(file,/COPY --chown=1000:1000 setup-bundles\/ \/sandbox\/\.openshell\/bundles\//)
  assert.ok(!file.includes('setup-installer'))
  assert.deepEqual(storedRecipe(recipe).setups,[id])
  assert.deepEqual(storedRecipe(newRecipe({source:'image',setups:[id]})).setups,[id])
})
test('setup recipe selection rejects duplicate, unknown-shape and excessive identifiers', () => {
  for(const setups of [[id,id],['../../path'],[null],Array.from({length:9},(_,i)=>String(i).repeat(24))]) assert.ok(recipeErrors(newRecipe({name:'test',setups})).setups)
})
