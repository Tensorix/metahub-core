import { expect, test } from 'bun:test';
import { databasePresentation } from './database-presentation';
import { virtualWindow } from './virtual-window';

test('touch metrics scale together and desktop density stays fixed',()=>{
 const phone=databasePresentation(true,1,390),large=databasePresentation(true,1.5,390);
 expect(phone).toMatchObject({row:48,wrappedRow:84,card:128,cardGap:8,timelineRow:56});
 expect(phone.timelineSide).toBeCloseTo(132.6);
 expect(large.card).toBe(192);expect(large.timelineRow).toBe(84);
 expect(databasePresentation(false,1,1440)).toMatchObject({row:44,wrappedRow:80,card:160,timelineRow:36,timelineSide:200});
 expect(databasePresentation(true,1,320).timelineSide).toBe(112);
 expect(databasePresentation(true,1,768).timelineSide).toBe(144);
});
test('50k cards use the same scaled stride for windows and scroll anchors',()=>{
 for(const scale of [1,1.3,2]){
  const p=databasePresentation(true,scale,402),stride=p.card+p.cardGap;
  const window=virtualWindow(50000,stride,40000*stride,600);
  expect(window.start).toBe(39996);expect(window.end-window.start).toBeLessThan(14);
  expect(window.before/stride).toBe(window.start);
  expect(window.before+(window.end-window.start)*stride+window.after).toBe(50000*stride);
 }
});
