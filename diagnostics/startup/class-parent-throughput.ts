// Exercise inherited dispatch/instanceof through mixed runtime values. This
// checks the hot lookup that gains an initialization-state branch in S3.
class Base {
  value: number;
  constructor(value: number) { this.value = value; }
  read() { return this.value; }
}
class Middle extends Base {}
class Leaf extends Middle {}
const values: any[] = [new Base(1), new Middle(2), new Leaf(3), { value: 4, read() { return this.value; } }];
function read(value: any): number {
  return value instanceof Base ? value.read() : 0;
}
let sum = 0;
for (let i = 0; i < 10000000; ++i) sum += read(values[i & 3]);
console.log('RESULT', sum);
