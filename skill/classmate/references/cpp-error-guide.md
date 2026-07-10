# C++ Error Guide

Use this file for compiler errors, linker errors, runtime errors, wrong output, and OJ failures.

## General Debug Flow

1. Identify the error type: compile, link, runtime, logic, or OJ failure.
2. Read the first meaningful error message.
3. Locate the file and line.
4. Explain the cause in plain Chinese.
5. Suggest the minimal fix.
6. Suggest one verification method if useful.

## Compile Errors

### `expected ';' before ...`

Meaning: the compiler expected a semicolon before this token.

Common causes:

- missing semicolon on the previous line
- missing semicolon after a class or struct definition
- syntax error before the reported line

### `was not declared in this scope`

Meaning: the name is used where the compiler does not know it.

Common causes:

- spelling mismatch
- variable declared inside another block
- using a variable before declaration
- missing header
- missing object name before a member

### `no matching function for call to ...`

Meaning: the function exists, but no version matches these arguments.

Common causes:

- wrong number of arguments
- wrong argument type
- constructor call mismatch
- missing `const` in some class member cases

### `cannot convert ...`

Meaning: the code tries to use one type as another incompatible type.

Common causes:

- assigning string to number
- passing pointer where object is expected
- returning the wrong type

### `invalid use of non-static member`

Meaning: an object member is being used without an object.

Common causes:

- using `ClassName.member`
- accessing ordinary members from a static function

### `private within this context`

Meaning: code outside the class is trying to access a private member.

Fix direction:

- use a public member function
- add getter/setter if appropriate
- move the operation into the class

## Link Errors

### `undefined reference to ...`

Meaning: the compiler saw a declaration, but the linker could not find the implementation.

Common causes:

- function declared but not defined
- `.cpp` file not included in build
- class member function missing `ClassName::`
- declaration and definition signatures differ

### `multiple definition of ...`

Meaning: the same function or variable is defined in more than one translation unit.

Common causes:

- defining ordinary functions in headers
- defining global variables in headers

## Runtime Errors

### Segmentation Fault

Meaning: the program accessed invalid memory.

Common causes:

- array index out of bounds
- null pointer dereference
- uninitialized pointer
- using memory after it is freed

### Infinite Loop

Common causes:

- loop condition never becomes false
- update statement missing
- wrong variable updated
- input failure keeps the condition unchanged

## Wrong Output

Common causes:

- boundary condition missing
- off-by-one
- variable not initialized
- integer division
- comparison rule is wrong
- object state not updated
- input/output format mismatch

## OJ Failure

When local samples pass but OJ fails, check:

- hidden boundary cases
- multiple test cases
- empty input or minimal input
- maximum input size
- integer overflow
- output spaces/newlines
- arrays not reset between test cases
- sorting comparison not satisfying the required rule
- relying only on sample cases

Suggest 2-3 targeted tests instead of a long list when possible.

## OOP-Specific Errors

### Constructor Not Working as Expected

Common causes:

- constructor signature mismatch
- object created with default constructor
- local variable shadows another object
- initialization is placed in the body when initializer list is needed

### Override Not Happening

Common causes:

- base function is not `virtual`
- derived function signature differs
- missing `const`
- parameter type mismatch

### Object Slicing

Meaning: a derived object is copied into a base object, losing the derived part.

Common example:

```cpp
Base b = Derived();
```

Fix direction: use base reference or pointer when polymorphism is needed.
