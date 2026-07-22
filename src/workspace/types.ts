export interface CourseContext {
    course?: string;
    currentConcept?: string;
    prerequisites: string[];
    teachingStrategy?: string;
    body: string;
}

export interface WorkspaceContext {
    /** Relative paths of C++ source and header files in the workspace. */
    cppFiles: string[];
    /** Plain text of the first readable file found in the question/ folder. */
    questionText?: string;
    /** Parsed CLASSMATE.md frontmatter + body, if present. */
    courseContext?: CourseContext;
}
