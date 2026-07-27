# Knowledge Map

Use this file for beginner-level concept explanations. Keep explanations within 程序设计基础, OOP, and introductory 数据结构.

## Course Reference Routing

For concept explanations, use these references together:

- `course-knowledge-trees.md`: use to identify where the concept sits in the course, what prerequisite knowledge it depends on, what later topics use it, and what concepts are easy to confuse with it.
- `basic-knowledge-explanations.md`: use for expanded beginner explanations, short code examples, and common mistake explanations.

Answer with the student's immediate question first. Add prerequisite or follow-up knowledge only when it helps the student understand the current blocker.

## Basic Syntax

### Variables and Types

Beginner explanation: a variable is a named place to store a value; the type decides what values and operations are allowed.

Common mistakes:

- using uninitialized local variables
- integer division when expecting decimals
- assigning incompatible types

### Input and Output

Explain `cin`, `cout`, `scanf`, `printf`, or language-specific equivalents according to the student's code.

Common mistakes:

- input order does not match the problem statement
- missing whitespace handling
- output format differs from OJ requirements

### Conditions

Explain `if`, `else if`, and `else` as branch selection.

Common mistakes:

- using `=` instead of `==`
- condition order is wrong
- boundary condition missing

### Loops

Explain:

- `for`: often used when repetition count is known
- `while`: often used when repetition depends on a condition

Common mistakes:

- off-by-one errors
- infinite loops
- updating the wrong variable

### Functions

Explain parameters as inputs and return values as outputs.

Common mistakes:

- forgetting `return`
- confusing parameter and argument
- expecting pass-by-value to modify the original variable

## Data Organization

### Arrays

An array stores several values of the same type, and indexes start at 0.

Common mistakes:

- index out of bounds
- confusing length with last index
- forgetting to initialize elements

### Strings

A string stores a sequence of characters.

Common mistakes:

- confusing character and string
- not handling spaces in input
- index out of bounds

### Structs

A struct groups related data together.

Use it before class if the concept is mainly "store several fields together".

## Pointers and References

### Pointer

A pointer stores the address of another variable.

Core ideas:

- `&x` gets the address of `x`
- `*p` accesses the value at address `p`

Common mistakes:

- using an uninitialized pointer
- dereferencing `nullptr`
- confusing pointer value and pointed value

### Reference

A reference is another name for an existing variable.

Common uses:

- avoid copying
- allow a function to modify the original variable

Common mistake: thinking a reference creates a new independent variable.

## OOP

### Class and Object

A class is a blueprint. An object is a concrete instance created from that blueprint.

Example framing:

- `Student` is a class.
- `Student s;` creates an object.

Common mistake: writing a class definition does not create an object.

### Member Variables and Member Functions

Member variables describe object state. Member functions describe what the object can do.

### Constructor

A constructor runs automatically when an object is created and usually initializes member variables.

Common mistakes:

- writing a return type for a constructor
- forgetting initialization
- declaration and definition signatures do not match

### Access Control and Encapsulation

Encapsulation keeps data private and exposes controlled operations through public functions.

Common mistake: making all fields public or trying to access private fields directly.

### Inheritance

Inheritance expresses an "is-a" relationship and lets a derived class reuse and extend a base class.

Common mistakes:

- forgetting `public` inheritance in C++
- trying to access private base members directly
- using inheritance when the relationship is not "is-a"

### Polymorphism

Polymorphism lets the same interface call different behavior depending on the actual object type.

Introductory C++ runtime polymorphism usually needs:

- base class pointer or reference
- `virtual` function
- derived class override

Common mistakes:

- forgetting `virtual`
- signature mismatch
- object slicing

### Operator Overloading

Operator overloading lets class objects use operators such as `+`, `<`, or `<<`.

Keep explanations introductory: meaning, syntax, and common use. Avoid advanced overload design unless asked.

## Data Structures

Cover basic arrays, linked lists, stacks, queues, trees, graphs, sorting, and searching when asked.

For algorithms, first explain:

1. What problem it solves.
2. What data it stores.
3. What each step does.
4. A small example trace.

Avoid advanced proof or optimization unless the student asks.
