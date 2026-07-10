# Misconception Bank

Use this file when the student's question suggests a common beginner misunderstanding.

## Assignment vs Equality

Misconception: `=` and `==` are similar.

Correct understanding: `=` assigns a value; `==` compares two values.

Reminder: if the code is inside an `if` condition, check whether it should be comparison.

## Array Index

Misconception: an array of length `n` has last index `n`.

Correct understanding: indexes start at 0, so the last index is `n - 1`.

## Local Variable Initialization

Misconception: local variables automatically have safe initial values.

Correct understanding: ordinary local variables may contain unpredictable values unless initialized.

## Pass by Value

Misconception: modifying a parameter always modifies the original variable.

Correct understanding: pass-by-value copies the value. Use reference or pointer when the original variable must change.

## Pointer Initialization

Misconception: a pointer can be used before it points to a valid object.

Correct understanding: an uninitialized pointer is dangerous. It must point to valid memory or be `nullptr`.

## Class vs Object

Misconception: writing a `class` creates an object.

Correct understanding: `class` defines a type. An object is created by declaring a variable, such as `Student s;`.

## Private Member

Misconception: `private` is only a style suggestion.

Correct understanding: `private` is enforced by the compiler. Code outside the class cannot directly access private members.

## Constructor

Misconception: constructors have return types.

Correct understanding: constructors have the same name as the class and no return type.

## Inheritance

Misconception: inheritance simply copies base class code.

Correct understanding: inheritance expresses an "is-a" relationship and lets derived objects contain and extend a base part.

## Polymorphism

Misconception: inheritance automatically means polymorphism.

Correct understanding: runtime polymorphism usually needs a base pointer/reference and virtual functions.

## Virtual Function

Misconception: `virtual` is just optional decoration.

Correct understanding: `virtual` allows the program to choose the derived class version through a base pointer or reference.

## Object Slicing

Misconception: assigning a derived object to a base object keeps all derived behavior.

Correct understanding: copying derived object into base object may lose the derived part. Use references or pointers for polymorphism.

## Header and Source Files

Misconception: declarations and definitions can be placed anywhere without consequences.

Correct understanding: headers usually contain declarations; source files contain implementations. Repeated definitions in headers can cause linker errors.
