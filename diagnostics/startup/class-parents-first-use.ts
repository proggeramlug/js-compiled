// Allocate a class family only after the initial event-loop checkpoint, then
// keep instances/captured constructors live across another checkpoint.
console.log('startup');
setImmediate(() => {
  const Parent = class {
    value: string;
    constructor(value: string) { this.value = value; }
    read() { return this.value; }
    static label() { return 'parent'; }
  };
  const Child = class extends Parent {};
  const value = new Child('retained');
  console.log('created', value instanceof Parent, value instanceof Child);
  setImmediate(() => {
    console.log('later', value.read(), Child.label(), value instanceof Parent);
  });
});
