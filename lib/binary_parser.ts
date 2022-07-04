class Context {
  code = "";
  scopes = [["vars"]];
  bitFields: Parser<unknown, "bit">[] = [];
  tmpVariableCount = 0;
  references = new Map<string, { resolved: boolean; requested: boolean }>();
  importPath: string;
  imports: any[] = [];
  reverseImports = new Map<any, number>();
  useContextVariables = false;

  constructor(importPath: string, useContextVariables: boolean) {
    this.importPath = importPath;
    this.useContextVariables = useContextVariables;
  }

  generateVariable(name?: string): string {
    const scopes = [...this.scopes[this.scopes.length - 1]];
    if (name) {
      scopes.push(name);
    }

    return scopes.join(".");
  }

  generateOption(val: number | string | Function): string {
    switch (typeof val) {
      case "number":
        return val.toString();
      case "string":
        return this.generateVariable(val);
      case "function":
        return `${this.addImport(val)}.call(${this.generateVariable()}, vars)`;
    }
  }

  generateError(err: string) {
    this.pushCode(`throw new Error(${err});`);
  }

  generateTmpVariable(): string {
    return "$tmp" + this.tmpVariableCount++;
  }

  pushCode(code: string) {
    this.code += code + "\n";
  }

  pushPath(name: string) {
    if (name) {
      this.scopes[this.scopes.length - 1].push(name);
    }
  }

  popPath(name: string) {
    if (name) {
      this.scopes[this.scopes.length - 1].pop();
    }
  }

  pushScope(name: string) {
    this.scopes.push([name]);
  }

  popScope() {
    this.scopes.pop();
  }

  addImport(im: any): string {
    if (!this.importPath) return `(${im})`;
    let id = this.reverseImports.get(im);
    if (!id) {
      id = this.imports.push(im) - 1;
      this.reverseImports.set(im, id);
    }
    return `${this.importPath}[${id}]`;
  }

  addReference(alias: string) {
    if (!this.references.has(alias)) {
      this.references.set(alias, { resolved: false, requested: false });
    }
  }

  markResolved(alias: string) {
    const reference = this.references.get(alias);

    if (reference) {
      reference.resolved = true;
    }
  }

  markRequested(aliasList: string[]) {
    aliasList.forEach((alias) => {
      const reference = this.references.get(alias);

      if (reference) {
        reference.requested = true;
      }
    });
  }

  getUnresolvedReferences(): string[] {
    return Array.from(this.references)
      .filter(([_, reference]) => !reference.resolved && !reference.requested)
      .map(([alias, _]) => alias);
  }
}

const aliasRegistry = new Map<string, Parser>();
const FUNCTION_PREFIX = "___parser_";

/**
 * Function type, that returns same type as receives.
 */
type DefaultFormatter<TPossibilities> = {
  [TKey in keyof TPossibilities]: (
    value: TPossibilities[TKey]
  ) => TPossibilities[TKey];
}[keyof TPossibilities];

type ExtractMapperType<TFn, TInput> = TFn extends (
  value: TInput
) => infer TValue
  ? TValue
  : TFn extends {
      (value: TInput): infer TValue;
    }
  ? TValue
  : never;

/**
 * Utility type, used to convert one type to another, using mapper type.
 * Each field of `TInput` will be converted by `TMapper` type.
 * @example
 * ```ts
 * type Input = {
 *   value: number;
 *   otherValue: string;
 * }
 *
 * // Mapping function, that maps all number values into Date, and all string values to number.
 * type CustomMapper = ((value: number) => Date) | ((value: string) => number);
 *
 * type MappedInput = Mapping<Input, CustomMapper>;
 *
 * // MappedInput now looks like:
 * // type MappedInput = {
 * //   value: Date;
 * //   otherValue: number;
 * // }
 * ```
 */
type Mapping<TInput, TMapper> = {
  [TKey in keyof TInput]: ExtractMapperType<TMapper, TInput[TKey]>;
};

type SplitBy<
  TRecord,
  TTagKey extends keyof TRecord,
  TChoices extends string | number | symbol
> = {
  [TKey in TChoices]: Omit<TRecord, TTagKey> & Record<TTagKey, TKey>;
};

type MergeTypes<TFirst, TSecond extends Record<keyof TFirst, unknown>> = {
  [TKey in keyof TFirst]: TFirst[TKey] & TSecond[TKey];
};

type OneOf<T> = {
  [K in keyof T]: Partial<Omit<Record<keyof T, undefined>, K>> &
    Record<K, T[K]>;
}[keyof T];

type PutUnderField<TRecord, TField extends string> = {
  [TKey in keyof TRecord]: Record<TField, TRecord[TKey]>;
};

type RequiredIf<TRecord, TValue> = TValue extends undefined
  ? TRecord
  : Required<TValue>;

type LengthProperty<TParserValue> =
  | number
  | keyof TParserValue
  | ((item: unknown) => number);
type ReadUntilProperty = "eof" | ((item: number, buffer: Buffer) => boolean);

// Utility type to extract only keys from TObject which are of type TType.
type KeysOfType<TObject, TType> = {
  // Iterate through all keys of TObject.
  // If value under key TKey has type TType, then put TKey in that place. If not, put never.
  [TKey in keyof TObject]: TObject[TKey] extends TType ? TKey : never;
  // Take all values of constructed object.
}[keyof TObject];

// Base type of "tag" option in ParserOptions type.
type ParserTag<TValue> = KeysOfType<TValue, number> | ((value: any) => number);
// Base type for entry of "choices" option in ParserOptions type.
type ParserChoice<TValue> = string | Parser<TValue>;
// Base type of "choices" option in ParserOptions type.
type ParserChoices = Record<number, ParserChoice<unknown>>;

type ChoiceToValue<TChoice, TEmpty> = TChoice extends Parser<infer TParserValue>
  ? TParserValue
  : TChoice extends "stop"
  ? TEmpty
  : unknown;

/**
 * Utility type, used to extract concrete value from choice.
 * Automatically handles specific string literals:
 *   "stop" - stop parsing, results in "undefined" type.
 * Other string literals could not be handled correctly, because named parsers
 *   are unknown during compile-time.
 */
type ChoicesToValues<TChoices extends ParserChoices, TEmpty> = {
  [TKey in keyof TChoices]: ChoiceToValue<TChoices[TKey], TEmpty>;
};

/**
 * Utility type, which constructs union type of all possibilities, from choices type.
 * Output value will be written to current object.
 * Limitations:
 *   - using named parsers will result in "unknown" type.
 *   - if TTag is function, union type without split on variable will be generated.
 * @example
 * If user specified TChoices type as:
 * ```ts
 * type TChoices = {
 *   0: Parser<{ value: string }>;
 *   1: Parser<{ otherValue: number }>;
 *   2: 'unknown-parser'
 * }
 * ```
 * TCurrentValue type as:
 * ```ts
 * type TCurrentValue = {
 *   someTag: number;
 * }
 * ```
 * And TTag as:
 * ```ts
 * type TTag = 'someTag';
 * ```
 * Then, return type will be:
 * ```ts
 * type Output = {
 *   someTag: 0;
 *   value: string;
 * } | {
 *   someTag: 1;
 *   otherValue: number;
 * } | {
 *   someTag: 2;
 * } & unknown; // limitation - cannot distinguish type.
 * ```
 * As you can see from the example above, one limitation exist:
 *   When named parsers are being used, type cannot be distinguished,
 *   because named parsers are not accessible during compile-time.
 * @example
 * If TChoices is:
 * ```ts
 * type TChoices = {
 *   0: Parser<{ value: string }>;
 *   1: Parser<{ anotherValue: number }>;
 * }
 * ```
 * TCurrentValue is:
 * ```ts
 * type TCurrentValue = {
 *   someValue: number;
 * }
 * ```
 * And TTag is:
 * ```ts
 * type TTag = (value: TCurrentValue) => number;
 * ```
 * Output type will be:
 * ```ts
 * type Output = {
 *   someValue: number;
 *   value: string;
 * } | {
 *   someValue: number;
 *   anotherValue: number;
 * }
 * ```
 * From the example above, another limitation occurs:
 *   When TTag is "function", the type will not be splitted by variable. As a result,
 *   output type could have all variables from all choices at one time, what is not true.
 */
type ChoicesToPossibleValues<
  // Type parameter, used to describe current parser value.
  TCurrentValue,
  // Type parameter, describes the criteria to choose one of specified choices.
  TTag extends ParserTag<TCurrentValue>,
  // Type parameter, describes all available choices.
  TChoices extends ParserChoices,
  // Type parameter, describes choice to pick if no other in "choices" found.
  TDefaultChoice extends ParserChoice<unknown> | undefined,
  TFormatter
> =
  | (TTag extends keyof TCurrentValue
      ? MergeTypes<
          SplitBy<TCurrentValue, TTag, keyof TChoices>,
          Mapping<ChoicesToValues<TChoices, {}>, TFormatter>
        >[keyof TChoices]
      : TCurrentValue &
          Mapping<ChoicesToValues<TChoices, {}>, TFormatter>[keyof TChoices])
  | (TDefaultChoice extends undefined
      ? never
      : TCurrentValue &
          ExtractMapperType<TFormatter, ChoiceToValue<TDefaultChoice, {}>>);

/**
 * Utility type, which constructs union type of all possibilities, from choices type.
 * Output value will be written into new variable.
 * Same behavior and limitations as ChoicesToPossibleValues, just output is being
 *   written into specified variable. @see {ChoicesToPossibleValues}
 */
type ChoicesToPossibleFieldValues<
  // Type parameter, which describes destination of constructed possibilities type.
  TVariableName extends string,
  // Type parameter, used to describe current parser value.
  TCurrentValue,
  // Type parameter, describes the criteria to choose one of specified choices.
  TTag extends ParserTag<TCurrentValue>,
  // Type parameter, describes all available choices.
  TChoices extends ParserChoices,
  // Type parameter, describes choice to pick if no other in "choices" found.
  TDefaultChoice extends ParserChoice<unknown> | undefined,
  TFormatter
> =
  | (TTag extends keyof TCurrentValue
      ? MergeTypes<
          SplitBy<TCurrentValue, TTag, keyof TChoices>,
          PutUnderField<
            Mapping<ChoicesToValues<TChoices, undefined>, TFormatter>,
            TVariableName
          >
        >[keyof TChoices]
      : TCurrentValue &
          Record<
            TVariableName,
            Mapping<
              ChoicesToValues<TChoices, undefined>,
              TFormatter
            >[keyof TChoices]
          >)
  | (TDefaultChoice extends undefined
      ? never
      : TCurrentValue &
          Record<
            TVariableName,
            ExtractMapperType<
              TFormatter,
              ChoiceToValue<TDefaultChoice, undefined>
            >
          >);

type ContinuousParserOptions<TParserValue> = {
  /**
   * Length of the buffer. Can be a number, string or a function.
   * Use number for statically sized buffers, string to reference another
   *   variable and function to do some calculation.
   */
  length: LengthProperty<TParserValue>;
  /**
   * If "eof", then this parser will read till it reaches the end of the
   *   Buffer/Uint8Array object. If it is a function, this parser will read
   *   the buffer until the function returns true.
   */
  readUntil: ReadUntilProperty;
};

/**
 * Options that can be used in all parsers.
 */
export type CommonParserOptions<TInputValue, TOutputValue> = {
  /**
   * Function that transforms the parsed value into a more desired form.
   */
  formatter?: (value: TInputValue) => TOutputValue;
  /**
   * Do assertion on the parsed result (useful for checking magic numbers and so on).
   * If `assert` is a `string` or `number`, the actual parsed result will be compared
   * with it with `===` (strict equality check), and an exception is thrown if they mismatch.
   * On the other hand, if `assert` is a function, that function is executed with one
   * argument (parsed result) and if it returns false, an exception is thrown.
   */
  assert?:
    | ((value: TInputValue) => boolean)
    | (TInputValue extends string | number ? TInputValue : never);
};

/**
 * Options for "bitN" parser.
 */
export type BitParserOptions<TOutputValue> = {
  length?: BitSizes;
} & CommonParserOptions<number, TOutputValue>;

/**
 * Options for "seek" parser.
 */
export type SeekParserOptions = {
  length: number;
} & CommonParserOptions<unknown, unknown>;

/**
 * Options for "string" parser.
 */
export type StringParserOptions<TParserValue, TOutputValue> = {
  /**
   * Specify which encoding to use.
   * Supported encodings include "hex" and all encodings supported by TextDecoder.
   * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder/encoding}
   * @default "utf-8"
   */
  encoding?: string;
  /**
   * Length of the string. Can be a number, string or a function.
   * Use number for statically sized arrays, string to reference another variable
   * and function to do some calculation.
   */
  length?: LengthProperty<TParserValue>;
  /**
   * If true, then this parser reads until it reaches zero.
   * @default false
   */
  zeroTerminated?: boolean;
  /**
   * If true, then this parser reads until it reaches the end of the buffer.
   * Will consume zero-bytes.
   * @default false
   */
  greedy?: boolean;
  /**
   * If true, then strip null characters from end of the string.
   * Must be used with length.
   */
  stripNull?: boolean;
} & CommonParserOptions<string, TOutputValue>;

/**
 * Options for "buffer" parser.
 */
export type BufferParserOptions<TParserValue, TOutputValue> = {
  /**
   * By default, `buffer(name [,options])` returns a new buffer which
   *   references the same memory as the parser input, but offset and
   *   cropped by a certain range.
   * If this option is true, input buffer will be cloned and a new buffer
   *   referencing a new memory region is returned.
   * @default false
   */
  clone?: boolean;
} & OneOf<ContinuousParserOptions<TParserValue>> &
  CommonParserOptions<Buffer, TOutputValue>;

/**
 * Options for "wrapped" parser.
 */
export type WrapperParserOptions<TParserValue, TType, TOutputValue> = {
  /**
   * A function taking a buffer and returning a buffer, transforming the
   * buffer into a buffer expected by `type`.
   */
  wrapper: (value: Buffer) => Buffer;
  /**
   * A `Parser` object to parse the result of wrapper.
   */
  type: Parser<TType>;

  clone?: boolean;
} & OneOf<ContinuousParserOptions<TParserValue>> &
  CommonParserOptions<TType, TOutputValue>;

/**
 * Options for "array" parser.
 */
export type ArrayParserOptions<
  TParserValue,
  TType extends PrimitiveTypes | Parser<unknown>,
  TOutputValue
> = {
  /**
   * Type of the array element.
   * Can be a string or an user defined `Parser` object.
   * If it's a string, you have to choose from `[u]int{8, 16, 32}{le, be}`.
   */
  type: TType;

  key?: string;
} & OneOf<
  ContinuousParserOptions<TParserValue> & {
    /**
     * Length of the array expressed in bytes. Can be a number,
     * string or a function. Use number for statically sized arrays.
     */
    lengthInBytes: LengthProperty<TParserValue>;
  }
> &
  CommonParserOptions<
    Array<TType extends Parser<infer TValue> ? TValue : number>,
    TOutputValue
  >;

/**
 * Options for "choice" parser.
 */
export type ChoiceParserOptions<
  TParserValue,
  TTag extends ParserTag<TParserValue>,
  TChoices extends ParserChoices,
  TDefaultChoice extends ParserChoice<unknown> | undefined,
  TFormatter
> = {
  /**
   * The value used to determine which parser to use from the `choices`.
   * Can be a string pointing to another field or a function.
   */
  tag: TTag;
  /**
   * An object which key is an integer and value is the parser which is
   *   executed when `tag` equals the key value.
   */
  choices: TChoices;
  /**
   * Function that transforms the parsed value into a more desired form.
   */
  formatter?: TFormatter;
} & RequiredIf<
  {
    /**
     * In case if the `tag` value doesn't match any of `choices`,
     *   this parser is used.
     */
    defaultChoice?: TDefaultChoice;
  },
  TDefaultChoice
> &
  Omit<CommonParserOptions<TChoices[keyof TChoices], unknown>, "formatter">;

/**
 * Options for "nest" parser.
 */
export type NestParserOptions<TNestedParserValue, TOutputValue> = {
  /**
   * A `Parser` object.
   */
  type: Parser<TNestedParserValue>;
} & CommonParserOptions<TNestedParserValue, TOutputValue>;

/**
 * Options for "pointer" parser.
 */
export type PointerParserOptions<
  TParserValue,
  TType extends PrimitiveTypes | Parser<unknown>,
  TOutputValue
> = {
  /**
   * Parser to execute.
   * Can be a string `[u]int{8, 16, 32, 64}{le, be}` or an user defined `Parser` object.
   */
  type: TType;
  /**
   * Indicates absolute offset from the beginning of the input buffer.
   * Can be a number, string or a function.
   */
  offset: LengthProperty<TParserValue>;
} & CommonParserOptions<
  TType extends Parser<infer TValue> ? TValue : number,
  TOutputValue
>;

/**
 * Options for "saveOffset" parser.
 */
export type SaveOffsetParserOptions<TOutputValue> = CommonParserOptions<
  number,
  TOutputValue
>;

type Types = PrimitiveTypes | ComplexTypes;

type ParserTypeToOptions<TOutputValue> = Record<
  PrimitiveTypes,
  CommonParserOptions<number, TOutputValue>
> & {
  bit: BitParserOptions<TOutputValue>;
  string: StringParserOptions<unknown, TOutputValue>;
  buffer: BufferParserOptions<unknown, TOutputValue>;
  array: ArrayParserOptions<
    unknown,
    Parser<unknown> | PrimitiveTypes,
    TOutputValue
  >;
  choice: ChoiceParserOptions<
    unknown,
    ParserTag<unknown>,
    ParserChoices,
    ParserChoice<unknown> | undefined,
    unknown
  >;
  nest: NestParserOptions<unknown, TOutputValue>;
  seek: SeekParserOptions;
  pointer: PointerParserOptions<
    unknown,
    Parser<unknown> | PrimitiveTypes,
    TOutputValue
  >;
  saveOffset: SaveOffsetParserOptions<TOutputValue>;
  wrapper: WrapperParserOptions<unknown, unknown, TOutputValue>;
};

type ParserConstraint = MergeTypes<
  SplitBy<{ type: Types }, "type", Types>,
  PutUnderField<{ [K in Types]: Parser<unknown, K> }, "parser">
>[Types];

type ComplexTypes =
  | "bit"
  | "string"
  | "buffer"
  | "array"
  | "choice"
  | "nest"
  | "seek"
  | "pointer"
  | "saveOffset"
  | "wrapper";

type Endianness = "be" | "le";

type PrimitiveTypes =
  | "uint8"
  | "uint16le"
  | "uint16be"
  | "uint32le"
  | "uint32be"
  | "uint64le"
  | "uint64be"
  | "int8"
  | "int16le"
  | "int16be"
  | "int32le"
  | "int32be"
  | "int64le"
  | "int64be"
  | "floatle"
  | "floatbe"
  | "doublele"
  | "doublebe";

type PrimitiveTypesWithoutEndian =
  | "uint8"
  | "uint16"
  | "uint32"
  | "int8"
  | "int16"
  | "int32"
  | "int64"
  | "uint64";

type BitSizes =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26
  | 27
  | 28
  | 29
  | 30
  | 31
  | 32;

const PRIMITIVE_SIZES: { [key in PrimitiveTypes]: number } = {
  uint8: 1,
  uint16le: 2,
  uint16be: 2,
  uint32le: 4,
  uint32be: 4,
  int8: 1,
  int16le: 2,
  int16be: 2,
  int32le: 4,
  int32be: 4,
  int64be: 8,
  int64le: 8,
  uint64be: 8,
  uint64le: 8,
  floatle: 4,
  floatbe: 4,
  doublele: 8,
  doublebe: 8,
};

const PRIMITIVE_NAMES: { [key in PrimitiveTypes]: string } = {
  uint8: "Uint8",
  uint16le: "Uint16",
  uint16be: "Uint16",
  uint32le: "Uint32",
  uint32be: "Uint32",
  int8: "Int8",
  int16le: "Int16",
  int16be: "Int16",
  int32le: "Int32",
  int32be: "Int32",
  int64be: "BigInt64",
  int64le: "BigInt64",
  uint64be: "BigUint64",
  uint64le: "BigUint64",
  floatle: "Float32",
  floatbe: "Float32",
  doublele: "Float64",
  doublebe: "Float64",
};

const PRIMITIVE_LITTLE_ENDIANS: { [key in PrimitiveTypes]: boolean } = {
  uint8: false,
  uint16le: true,
  uint16be: false,
  uint32le: true,
  uint32be: false,
  int8: false,
  int16le: true,
  int16be: false,
  int32le: true,
  int32be: false,
  int64be: false,
  int64le: true,
  uint64be: false,
  uint64le: true,
  floatle: true,
  floatbe: false,
  doublele: true,
  doublebe: false,
};

export class Parser<T = {}, ParserType extends Types = Types> {
  varName = "";
  type: ParserType = "" as ParserType;
  options: ParserTypeToOptions<unknown>[ParserType] =
    {} as ParserTypeToOptions<unknown>[ParserType];
  next?: Parser;
  head?: Parser;
  compiled?: Function;
  endian: Endianness = "be";
  constructorFn?: Function;
  alias?: string;
  useContextVariables = false;

  constructor() {}

  static start() {
    return new Parser();
  }

  private primitiveGenerateN(type: PrimitiveTypes, ctx: Context) {
    const typeName = PRIMITIVE_NAMES[type];
    const littleEndian = PRIMITIVE_LITTLE_ENDIANS[type];
    ctx.pushCode(
      `${ctx.generateVariable(
        this.varName
      )} = dataView.get${typeName}(offset, ${littleEndian});`
    );
    ctx.pushCode(`offset += ${PRIMITIVE_SIZES[type]};`);
  }

  private primitiveN<TVariableName extends string, TOutputValue = number>(
    type: PrimitiveTypes,
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue>
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.setNextParser(type, varName, options);
  }

  private useThisEndian(type: PrimitiveTypesWithoutEndian): PrimitiveTypes {
    return (type + this.endian.toLowerCase()) as PrimitiveTypes;
  }

  uint8<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("uint8", varName, options);
  }

  uint16<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN(this.useThisEndian("uint16"), varName, options);
  }

  uint16le<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("uint16le", varName, options);
  }

  uint16be<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("uint16be", varName, options);
  }

  uint32<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN(this.useThisEndian("uint32"), varName, options);
  }

  uint32le<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("uint32le", varName, options);
  }

  uint32be<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("uint32be", varName, options);
  }

  int8<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("int8", varName, options);
  }

  int16<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN(this.useThisEndian("int16"), varName, options);
  }

  int16le<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("int16le", varName, options);
  }

  int16be<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("int16be", varName, options);
  }

  int32<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN(this.useThisEndian("int32"), varName, options);
  }

  int32le<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("int32le", varName, options);
  }

  int32be<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("int32be", varName, options);
  }

  private bigIntVersionCheck() {
    if (!DataView.prototype.getBigInt64)
      throw new Error("BigInt64 is unsupported on this runtime");
  }

  int64<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    this.bigIntVersionCheck();
    return this.primitiveN(this.useThisEndian("int64"), varName, options);
  }

  int64be<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    this.bigIntVersionCheck();
    return this.primitiveN("int64be", varName, options);
  }

  int64le<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    this.bigIntVersionCheck();
    return this.primitiveN("int64le", varName, options);
  }

  uint64<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    this.bigIntVersionCheck();
    return this.primitiveN(this.useThisEndian("uint64"), varName, options);
  }

  uint64be<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    this.bigIntVersionCheck();
    return this.primitiveN("uint64be", varName, options);
  }

  uint64le<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    this.bigIntVersionCheck();
    return this.primitiveN("uint64le", varName, options);
  }

  floatle<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("floatle", varName, options);
  }

  floatbe<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("floatbe", varName, options);
  }

  doublele<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("doublele", varName, options);
  }

  doublebe<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.primitiveN("doublebe", varName, options);
  }

  private bitN<TVariableName extends string, TOutputValue = number>(
    size: BitSizes,
    varName: TVariableName,
    options: BitParserOptions<TOutputValue>
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    options.length = size;
    return this.setNextParser("bit", varName, options);
  }

  bit1<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(1, varName, options);
  }

  bit2<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(2, varName, options);
  }

  bit3<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(3, varName, options);
  }

  bit4<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(4, varName, options);
  }

  bit5<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(5, varName, options);
  }

  bit6<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(6, varName, options);
  }

  bit7<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(7, varName, options);
  }

  bit8<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(8, varName, options);
  }

  bit9<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(9, varName, options);
  }

  bit10<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(10, varName, options);
  }

  bit11<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(11, varName, options);
  }

  bit12<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(12, varName, options);
  }

  bit13<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(13, varName, options);
  }

  bit14<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(14, varName, options);
  }

  bit15<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(15, varName, options);
  }

  bit16<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(16, varName, options);
  }

  bit17<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(17, varName, options);
  }

  bit18<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(18, varName, options);
  }

  bit19<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(19, varName, options);
  }

  bit20<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(20, varName, options);
  }

  bit21<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(21, varName, options);
  }

  bit22<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(22, varName, options);
  }

  bit23<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(23, varName, options);
  }

  bit24<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(24, varName, options);
  }

  bit25<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(25, varName, options);
  }

  bit26<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(26, varName, options);
  }

  bit27<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(27, varName, options);
  }

  bit28<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(28, varName, options);
  }

  bit29<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(29, varName, options);
  }

  bit30<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(30, varName, options);
  }

  bit31<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(31, varName, options);
  }

  bit32<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: CommonParserOptions<number, TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.bitN(32, varName, options);
  }

  namely(alias: string): this {
    aliasRegistry.set(alias, this);
    this.alias = alias;
    return this;
  }

  skip(
    length: LengthProperty<T>,
    options: CommonParserOptions<unknown, unknown> = {}
  ): Parser<T> {
    return this.seek(length, options);
  }

  seek(
    relOffset: LengthProperty<T>,
    options: CommonParserOptions<unknown, unknown> = {}
  ): Parser<T> {
    if (options.assert) {
      throw new Error("assert option on seek is not allowed.");
    }

    return this.setNextParser("seek", "", {
      length: relOffset,
    } as SeekParserOptions);
  }

  string<TVariableName extends string, TOutputValue = string>(
    varName: TVariableName,
    options: StringParserOptions<T, TOutputValue>
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    if (!options.zeroTerminated && !options.length && !options.greedy) {
      throw new Error(
        "One of length, zeroTerminated, or greedy must be defined for string."
      );
    }

    if ((options.zeroTerminated || options.length) && options.greedy) {
      throw new Error(
        "greedy is mutually exclusive with length and zeroTerminated for string."
      );
    }

    if (options.stripNull && !(options.length || options.greedy)) {
      throw new Error(
        "length or greedy must be defined if stripNull is enabled."
      );
    }

    options.encoding = options.encoding || "utf8";

    return this.setNextParser(
      "string",
      varName,
      options as StringParserOptions<unknown, TOutputValue>
    );
  }

  buffer<TVariableName extends string, TOutputValue = Buffer>(
    varName: TVariableName,
    options: BufferParserOptions<T, TOutputValue>
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    if (!options.length && !options.readUntil) {
      throw new Error("length or readUntil must be defined for buffer.");
    }

    return this.setNextParser(
      "buffer",
      varName,
      options as BufferParserOptions<unknown, TOutputValue>
    );
  }

  wrapped<TVariableName extends string, TType, TOutputValue = TType>(
    varName: TVariableName,
    options: WrapperParserOptions<T, TType, TOutputValue>
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    if (!options.length && !options.readUntil) {
      throw new Error("length or readUntil must be defined for wrapped.");
    }

    if (!options.wrapper || !options.type) {
      throw new Error("Both wrapper and type must be defined for wrapped.");
    }

    return this.setNextParser(
      "wrapper",
      varName,
      options as WrapperParserOptions<unknown, unknown, TOutputValue>
    );
  }

  array<
    TVariableName extends string,
    TType extends PrimitiveTypes | Parser<unknown>,
    TOutputValue = Array<TType extends Parser<infer TValue> ? TValue : number>
  >(
    varName: TVariableName,
    options: ArrayParserOptions<T, TType, TOutputValue>
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    if (!options.readUntil && !options.length && !options.lengthInBytes) {
      throw new Error(
        "One of readUntil, length and lengthInBytes must be defined for array."
      );
    }

    if (!options.type) {
      throw new Error("type is required for array.");
    }

    if (
      typeof options.type === "string" &&
      !aliasRegistry.has(options.type) &&
      !(options.type in PRIMITIVE_SIZES)
    ) {
      throw new Error(`Array element type "${options.type}" is unknown.`);
    }

    return this.setNextParser<TVariableName, "array", TOutputValue>(
      "array",
      varName,
      options as ArrayParserOptions<
        unknown,
        Parser<unknown> | PrimitiveTypes,
        TOutputValue
      >
    );
  }

  choice<
    TTag extends ParserTag<T>,
    TChoices extends ParserChoices,
    TDefaultChoice extends ParserChoice<unknown> | undefined = undefined,
    TFormatter = DefaultFormatter<TChoices>
  >(
    options: ChoiceParserOptions<T, TTag, TChoices, TDefaultChoice, TFormatter>
  ): Parser<
    ChoicesToPossibleValues<T, TTag, TChoices, TDefaultChoice, TFormatter>
  >;

  choice<
    TVariableName extends string,
    TTag extends ParserTag<T>,
    TChoices extends ParserChoices,
    TDefaultChoice extends ParserChoice<unknown> | undefined = undefined,
    TFormatter = DefaultFormatter<TChoices>
  >(
    varName: TVariableName,
    options: ChoiceParserOptions<T, TTag, TChoices, TDefaultChoice, TFormatter>
  ): Parser<
    ChoicesToPossibleFieldValues<
      TVariableName,
      T,
      TTag,
      TChoices,
      TDefaultChoice,
      TFormatter
    >
  >;

  choice<
    TVariableName extends string,
    TTag extends ParserTag<T>,
    TChoices extends ParserChoices,
    TDefaultChoice extends ParserChoice<unknown> | undefined = undefined,
    TFormatter = DefaultFormatter<TChoices>
  >(
    varName:
      | TVariableName
      | ChoiceParserOptions<T, TTag, TChoices, TDefaultChoice, TFormatter>,
    options?: ChoiceParserOptions<T, TTag, TChoices, TDefaultChoice, TFormatter>
  ):
    | Parser<
        ChoicesToPossibleValues<T, TTag, TChoices, TDefaultChoice, TFormatter>
      >
    | Parser<
        ChoicesToPossibleFieldValues<
          TVariableName,
          T,
          TTag,
          TChoices,
          TDefaultChoice,
          TFormatter
        >
      > {
    if (typeof options !== "object" && typeof varName === "object") {
      options = varName;
      varName = "" as TVariableName;
    }

    if (!options) {
      throw new Error("tag and choices are are required for choice.");
    }

    if (!options.tag) {
      throw new Error("tag is required for choice.");
    }

    if (!options.choices) {
      throw new Error("choices is required for choice.");
    }

    for (const keyString in options.choices) {
      const key = parseInt(keyString, 10);
      const value = options.choices[key];

      if (isNaN(key)) {
        throw new Error(`Choice key "${keyString}" is not a number.`);
      }

      if (
        typeof value === "string" &&
        !aliasRegistry.has(value) &&
        !((value as string) in PRIMITIVE_SIZES)
      ) {
        throw new Error(`Choice type "${value}" is unknown.`);
      }
    }

    return this.setNextParser(
      "choice",
      varName as TVariableName,
      options as ChoiceParserOptions<
        unknown,
        ParserTag<unknown>,
        ParserChoices,
        ParserChoice<unknown> | undefined,
        unknown
      >
    ) as Parser<
      ChoicesToPossibleValues<T, TTag, TChoices, TDefaultChoice, TFormatter>
    >;
  }

  nest<TVariableName extends string, TType, TOutputValue = TType>(
    varName: TVariableName,
    options: NestParserOptions<TType, TOutputValue>
  ): Parser<T & Record<TVariableName, TOutputValue>>;

  nest<TType, TOutputValue = TType>(
    options: NestParserOptions<TType, TOutputValue>
  ): Parser<T & TOutputValue>;

  nest<TVariableName extends string, TType, TOutputValue = TType>(
    varName: TVariableName | NestParserOptions<TType, TOutputValue>,
    options?: NestParserOptions<TType, TOutputValue>
  ):
    | Parser<T & TOutputValue>
    | Parser<T & Record<TVariableName, TOutputValue>> {
    if (typeof options !== "object" && typeof varName === "object") {
      options = varName;
      varName = "" as TVariableName;
    }

    if (!options || !options.type) {
      throw new Error("type is required for nest.");
    }

    if (!(options.type instanceof Parser) && !aliasRegistry.has(options.type)) {
      throw new Error("type must be a known parser name or a Parser object.");
    }

    if (!(options.type instanceof Parser) && !varName) {
      throw new Error(
        "type must be a Parser object if the variable name is omitted."
      );
    }

    return this.setNextParser(
      "nest",
      varName as string,
      (options as NestParserOptions<unknown, TOutputValue>) || {}
    );
  }

  pointer<
    TVariableName extends string,
    TType extends Parser<unknown> | PrimitiveTypes,
    TOutputValue = TType extends Parser<infer TValue> ? TValue : number
  >(
    varName: TVariableName,
    options: PointerParserOptions<T, TType, TOutputValue>
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    if (!options.offset) {
      throw new Error("offset is required for pointer.");
    }

    if (!options.type) {
      throw new Error("type is required for pointer.");
    }

    if (
      typeof options.type === "string" &&
      !(options.type in PRIMITIVE_SIZES) &&
      !aliasRegistry.has(options.type)
    ) {
      throw new Error(`Pointer type "${options.type}" is unknown.`);
    }

    return this.setNextParser(
      "pointer",
      varName,
      options as PointerParserOptions<unknown, Parser<unknown>, TOutputValue>
    );
  }

  saveOffset<TVariableName extends string, TOutputValue = number>(
    varName: TVariableName,
    options: SaveOffsetParserOptions<TOutputValue> = {}
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    return this.setNextParser("saveOffset", varName, options);
  }

  endianness(endianness: "little" | "big"): this {
    switch (endianness.toLowerCase()) {
      case "little":
        this.endian = "le";
        break;
      case "big":
        this.endian = "be";
        break;
      default:
        throw new Error('endianness must be one of "little" or "big"');
    }

    return this;
  }

  endianess(endianess: "little" | "big"): this {
    return this.endianness(endianess);
  }

  useContextVars(useContextVariables = true): this {
    this.useContextVariables = useContextVariables;

    return this;
  }

  create(constructorFn: Function): this {
    if (!(constructorFn instanceof Function)) {
      throw new Error("Constructor must be a Function object.");
    }

    this.constructorFn = constructorFn;

    return this;
  }

  private getContext(importPath: string): Context {
    const ctx = new Context(importPath, this.useContextVariables);

    ctx.pushCode(
      "var dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);"
    );

    if (!this.alias) {
      this.addRawCode(ctx);
    } else {
      this.addAliasedCode(ctx);
      ctx.pushCode(`return ${FUNCTION_PREFIX + this.alias}(0).result;`);
    }

    return ctx;
  }

  getCode(): string {
    const importPath = "imports";
    return this.getContext(importPath).code;
  }

  private addRawCode(ctx: Context) {
    ctx.pushCode("var offset = 0;");
    ctx.pushCode(
      `var vars = ${this.constructorFn ? "new constructorFn()" : "{}"};`
    );

    ctx.pushCode("vars.$parent = null;");
    ctx.pushCode("vars.$root = vars;");

    this.generate(ctx);
    this.resolveReferences(ctx);

    ctx.pushCode("delete vars.$parent;");
    ctx.pushCode("delete vars.$root;");

    ctx.pushCode("return vars;");
  }

  private addAliasedCode(ctx: Context) {
    ctx.pushCode(`function ${FUNCTION_PREFIX + this.alias}(offset, context) {`);
    ctx.pushCode(
      `var vars = ${this.constructorFn ? "new constructorFn()" : "{}"};`
    );
    ctx.pushCode(
      "var ctx = Object.assign({$parent: null, $root: vars}, context || {});"
    );
    ctx.pushCode(`vars = Object.assign(vars, ctx);`);

    this.generate(ctx);

    ctx.markResolved(this.alias!);
    this.resolveReferences(ctx);

    ctx.pushCode(
      "Object.keys(ctx).forEach(function (item) { delete vars[item]; });"
    );
    ctx.pushCode("return { offset: offset, result: vars };");
    ctx.pushCode("}");

    return ctx;
  }

  private resolveReferences(ctx: Context) {
    const references = ctx.getUnresolvedReferences();
    ctx.markRequested(references);
    references.forEach((alias) => {
      aliasRegistry.get(alias)?.addAliasedCode(ctx);
    });
  }

  compile() {
    const importPath = "imports";
    const ctx = this.getContext(importPath);
    this.compiled = new Function(
      importPath,
      "TextDecoder",
      `return function (buffer, constructorFn) { ${ctx.code} };`
    )(ctx.imports, TextDecoder);
  }

  sizeOf(): number {
    let size = NaN;

    const constraint = { type: this.type, parser: this } as ParserConstraint;

    if (Object.keys(PRIMITIVE_SIZES).indexOf(this.type) >= 0) {
      size = PRIMITIVE_SIZES[this.type as PrimitiveTypes];

      // if this is a fixed length string
    } else if (
      constraint.type === "string" &&
      typeof constraint.parser.options.length === "number"
    ) {
      size = constraint.parser.options.length;

      // if this is a fixed length buffer
    } else if (
      constraint.type === "buffer" &&
      typeof constraint.parser.options.length === "number"
    ) {
      size = constraint.parser.options.length;

      // if this is a fixed length array
    } else if (
      constraint.type === "array" &&
      typeof constraint.parser.options.length === "number"
    ) {
      let elementSize = NaN;
      if (typeof constraint.type === "string") {
        elementSize =
          PRIMITIVE_SIZES[constraint.parser.options.type as PrimitiveTypes];
      } else if (constraint.parser.options.type instanceof Parser) {
        elementSize = constraint.parser.options.type.sizeOf();
      }
      size = constraint.parser.options.length * elementSize;

      // if this a skip
    } else if (constraint.type === "seek") {
      size = constraint.parser.options.length as number;

      // if this is a nested parser
    } else if (constraint.type === "nest") {
      size = constraint.parser.options.type.sizeOf();
    } else if (!this.type) {
      size = 0;
    }

    if (this.next) {
      size += this.next.sizeOf();
    }

    return size;
  }

  // Follow the parser chain till the root and start parsing from there
  parse(buffer: Buffer | Uint8Array): T {
    if (!this.compiled) {
      this.compile();
    }

    return this.compiled!(buffer, this.constructorFn);
  }

  private setNextParser<
    TVariableName extends string,
    TType extends Types,
    TOutputValue
  >(
    type: TType,
    varName: TVariableName,
    options: ParserTypeToOptions<TOutputValue>[TType]
  ): Parser<T & Record<TVariableName, TOutputValue>> {
    const parser = new Parser();

    parser.type = type;
    parser.varName = varName;
    parser.options = options;
    parser.endian = this.endian;

    if (this.head) {
      this.head.next = parser;
    } else {
      this.next = parser;
    }
    this.head = parser;

    return this as unknown as Parser<T & Record<TVariableName, TOutputValue>>;
  }

  // Call code generator for this parser
  private generate(ctx: Context) {
    if (this.type) {
      const constraint = { type: this.type, parser: this } as ParserConstraint;
      switch (constraint.type) {
        case "uint8":
        case "uint16le":
        case "uint16be":
        case "uint32le":
        case "uint32be":
        case "int8":
        case "int16le":
        case "int16be":
        case "int32le":
        case "int32be":
        case "int64be":
        case "int64le":
        case "uint64be":
        case "uint64le":
        case "floatle":
        case "floatbe":
        case "doublele":
        case "doublebe":
          this.primitiveGenerateN(constraint.type, ctx);
          break;
        case "bit":
          constraint.parser.generateBit(ctx);
          break;
        case "string":
          constraint.parser.generateString(ctx);
          break;
        case "buffer":
          constraint.parser.generateBuffer(ctx);
          break;
        case "seek":
          constraint.parser.generateSeek(ctx);
          break;
        case "nest":
          constraint.parser.generateNest(ctx);
          break;
        case "array":
          constraint.parser.generateArray(ctx);
          break;
        case "choice":
          constraint.parser.generateChoice(ctx);
          break;
        case "pointer":
          constraint.parser.generatePointer(ctx);
          break;
        case "saveOffset":
          constraint.parser.generateSaveOffset(ctx);
          break;
        case "wrapper":
          constraint.parser.generateWrapper(ctx);
          break;
      }
      if (constraint.type !== "bit") this.generateAssert(ctx);
    }

    const varName = ctx.generateVariable(this.varName);
    if (this.options.formatter && this.type !== "bit") {
      this.generateFormatter(ctx, varName, this.options.formatter as Function);
    }

    return this.generateNext(ctx);
  }

  private generateAssert(ctx: Context) {
    if (!this.options.assert) {
      return;
    }

    const varName = ctx.generateVariable(this.varName);

    switch (typeof this.options.assert) {
      case "function":
        {
          const func = ctx.addImport(this.options.assert);
          ctx.pushCode(`if (!${func}.call(vars, ${varName})) {`);
        }
        break;
      case "number":
        ctx.pushCode(`if (${this.options.assert} !== ${varName}) {`);
        break;
      case "string":
        ctx.pushCode(
          `if (${JSON.stringify(this.options.assert)} !== ${varName}) {`
        );
        break;
      default:
        throw new Error(
          "assert option must be a string, number or a function."
        );
    }
    ctx.generateError(
      `"Assertion error: ${varName} is " + ${JSON.stringify(
        this.options.assert.toString()
      )}`
    );
    ctx.pushCode("}");
  }

  // Recursively call code generators and append results
  private generateNext(ctx: Context): Context {
    if (this.next) {
      ctx = this.next.generate(ctx);
    }

    return ctx;
  }

  private generateBit(this: Parser<T, "bit">, ctx: Context) {
    // TODO find better method to handle nested bit fields
    const parser: Parser<T, "bit"> = JSON.parse(JSON.stringify(this));
    parser.options = this.options;
    parser.generateAssert = this.generateAssert.bind(this);
    parser.generateFormatter = this.generateFormatter.bind(this);
    parser.varName = ctx.generateVariable(parser.varName);
    ctx.bitFields.push(parser);

    if (
      !this.next ||
      (this.next && ["bit", "nest"].indexOf(this.next.type) < 0)
    ) {
      const val = ctx.generateTmpVariable();

      ctx.pushCode(`var ${val} = 0;`);

      const getMaxBits = (from = 0) => {
        let sum = 0;
        for (let i = from; i < ctx.bitFields.length; i++) {
          const length = ctx.bitFields[i].options.length!;
          if (sum + length > 32) break;
          sum += length;
        }
        return sum;
      };

      const getBytes = (sum: number) => {
        if (sum <= 8) {
          ctx.pushCode(`${val} = dataView.getUint8(offset);`);
          sum = 8;
        } else if (sum <= 16) {
          ctx.pushCode(`${val} = dataView.getUint16(offset);`);
          sum = 16;
        } else if (sum <= 24) {
          ctx.pushCode(
            `${val} = (dataView.getUint16(offset) << 8) | dataView.getUint8(offset + 2);`
          );
          sum = 24;
        } else {
          ctx.pushCode(`${val} = dataView.getUint32(offset);`);
          sum = 32;
        }
        ctx.pushCode(`offset += ${sum / 8};`);
        return sum;
      };

      let bitOffset = 0;
      const isBigEndian = this.endian === "be";

      let sum = 0;
      let rem = 0;

      ctx.bitFields.forEach((parser, i) => {
        let length = parser.options.length as number;
        if (length > rem) {
          if (rem) {
            const mask = -1 >>> (32 - rem);
            ctx.pushCode(
              `${parser.varName} = (${val} & 0x${mask.toString(16)}) << ${
                length - rem
              };`
            );
            length -= rem;
          }
          bitOffset = 0;
          rem = sum = getBytes(getMaxBits(i) - rem);
        }
        const offset = isBigEndian ? sum - bitOffset - length : bitOffset;
        const mask = -1 >>> (32 - length);

        ctx.pushCode(
          `${parser.varName} ${
            length < (parser.options.length as number) ? "|=" : "="
          } ${val} >> ${offset} & 0x${mask.toString(16)};`
        );

        // Ensure value is unsigned
        if ((parser.options.length as number) === 32) {
          ctx.pushCode(`${parser.varName} >>>= 0`);
        }

        if (parser.options.assert) {
          parser.generateAssert(ctx);
        }

        if (parser.options.formatter) {
          parser.generateFormatter(
            ctx,
            parser.varName,
            parser.options.formatter
          );
        }

        bitOffset += length;
        rem -= length;
      });

      ctx.bitFields = [];
    }
  }

  private generateSeek(this: Parser<T, "seek">, ctx: Context) {
    const length = ctx.generateOption(this.options.length!);
    ctx.pushCode(`offset += ${length};`);
  }

  private generateString(this: Parser<T, "string">, ctx: Context) {
    const name = ctx.generateVariable(this.varName);
    const start = ctx.generateTmpVariable();
    const encoding = this.options.encoding!;
    const isHex = encoding.toLowerCase() === "hex";
    const toHex = 'b => b.toString(16).padStart(2, "0")';

    if (this.options.length && this.options.zeroTerminated) {
      const len = this.options.length;
      ctx.pushCode(`var ${start} = offset;`);
      ctx.pushCode(
        `while(dataView.getUint8(offset++) !== 0 && offset - ${start} < ${len});`
      );
      const end = `offset - ${start} < ${len} ? offset - 1 : offset`;
      ctx.pushCode(
        isHex
          ? `${name} = Array.from(buffer.subarray(${start}, ${end}), ${toHex}).join('');`
          : `${name} = new TextDecoder('${encoding}').decode(buffer.subarray(${start}, ${end}));`
      );
    } else if (this.options.length) {
      const len = ctx.generateOption(this.options.length);
      ctx.pushCode(
        isHex
          ? `${name} = Array.from(buffer.subarray(offset, offset + ${len}), ${toHex}).join('');`
          : `${name} = new TextDecoder('${encoding}').decode(buffer.subarray(offset, offset + ${len}));`
      );
      ctx.pushCode(`offset += ${len};`);
    } else if (this.options.zeroTerminated) {
      ctx.pushCode(`var ${start} = offset;`);
      ctx.pushCode("while(dataView.getUint8(offset++) !== 0);");
      ctx.pushCode(
        isHex
          ? `${name} = Array.from(buffer.subarray(${start}, offset - 1), ${toHex}).join('');`
          : `${name} = new TextDecoder('${encoding}').decode(buffer.subarray(${start}, offset - 1));`
      );
    } else if (this.options.greedy) {
      ctx.pushCode(`var ${start} = offset;`);
      ctx.pushCode("while(buffer.length > offset++);");
      ctx.pushCode(
        isHex
          ? `${name} = Array.from(buffer.subarray(${start}, offset), ${toHex}).join('');`
          : `${name} = new TextDecoder('${encoding}').decode(buffer.subarray(${start}, offset));`
      );
    }
    if (this.options.stripNull) {
      ctx.pushCode(`${name} = ${name}.replace(/\\x00+$/g, '')`);
    }
  }

  private generateBuffer(this: Parser<T, "buffer">, ctx: Context) {
    const varName = ctx.generateVariable(this.varName);

    if (typeof this.options.readUntil === "function") {
      const pred = this.options.readUntil;
      const start = ctx.generateTmpVariable();
      const cur = ctx.generateTmpVariable();

      ctx.pushCode(`var ${start} = offset;`);
      ctx.pushCode(`var ${cur} = 0;`);
      ctx.pushCode(`while (offset < buffer.length) {`);
      ctx.pushCode(`${cur} = dataView.getUint8(offset);`);
      const func = ctx.addImport(pred);
      ctx.pushCode(
        `if (${func}.call(${ctx.generateVariable()}, ${cur}, buffer.subarray(offset))) break;`
      );
      ctx.pushCode(`offset += 1;`);
      ctx.pushCode(`}`);
      ctx.pushCode(`${varName} = buffer.subarray(${start}, offset);`);
    } else if (this.options.readUntil === "eof") {
      ctx.pushCode(`${varName} = buffer.subarray(offset);`);
    } else {
      const len = ctx.generateOption(this.options.length!);

      ctx.pushCode(`${varName} = buffer.subarray(offset, offset + ${len});`);
      ctx.pushCode(`offset += ${len};`);
    }

    if (this.options.clone) {
      ctx.pushCode(`${varName} = buffer.constructor.from(${varName});`);
    }
  }

  private generateArray(this: Parser<T, "array">, ctx: Context) {
    const length = ctx.generateOption(this.options.length!);
    const lengthInBytes = ctx.generateOption(this.options.lengthInBytes!);
    const type = this.options.type;
    const counter = ctx.generateTmpVariable();
    const lhs = ctx.generateVariable(this.varName);
    const item = ctx.generateTmpVariable();
    const key = this.options.key;
    const isHash = typeof key === "string";

    if (isHash) {
      ctx.pushCode(`${lhs} = {};`);
    } else {
      ctx.pushCode(`${lhs} = [];`);
    }
    if (typeof this.options.readUntil === "function") {
      ctx.pushCode("do {");
    } else if (this.options.readUntil === "eof") {
      ctx.pushCode(
        `for (var ${counter} = 0; offset < buffer.length; ${counter}++) {`
      );
    } else if (lengthInBytes !== undefined) {
      ctx.pushCode(
        `for (var ${counter} = offset + ${lengthInBytes}; offset < ${counter}; ) {`
      );
    } else {
      ctx.pushCode(
        `for (var ${counter} = ${length}; ${counter} > 0; ${counter}--) {`
      );
    }

    if (typeof type === "string") {
      if (!aliasRegistry.get(type)) {
        const typeName = PRIMITIVE_NAMES[type as PrimitiveTypes];
        const littleEndian = PRIMITIVE_LITTLE_ENDIANS[type as PrimitiveTypes];
        ctx.pushCode(
          `var ${item} = dataView.get${typeName}(offset, ${littleEndian});`
        );
        ctx.pushCode(`offset += ${PRIMITIVE_SIZES[type as PrimitiveTypes]};`);
      } else {
        const tempVar = ctx.generateTmpVariable();
        ctx.pushCode(`var ${tempVar} = ${FUNCTION_PREFIX + type}(offset, {`);
        if (ctx.useContextVariables) {
          const parentVar = ctx.generateVariable();
          ctx.pushCode(`$parent: ${parentVar},`);
          ctx.pushCode(`$root: ${parentVar}.$root,`);
          if (!this.options.readUntil && lengthInBytes === undefined) {
            ctx.pushCode(`$index: ${length} - ${counter},`);
          }
        }
        ctx.pushCode(`});`);
        ctx.pushCode(
          `var ${item} = ${tempVar}.result; offset = ${tempVar}.offset;`
        );
        if (type !== this.alias) ctx.addReference(type);
      }
    } else if (type instanceof Parser) {
      ctx.pushCode(`var ${item} = {};`);
      const parentVar = ctx.generateVariable();
      ctx.pushScope(item);

      if (ctx.useContextVariables) {
        ctx.pushCode(`${item}.$parent = ${parentVar};`);
        ctx.pushCode(`${item}.$root = ${parentVar}.$root;`);
        if (!this.options.readUntil && lengthInBytes === undefined) {
          ctx.pushCode(`${item}.$index = ${length} - ${counter};`);
        }
      }

      type.generate(ctx);

      if (ctx.useContextVariables) {
        ctx.pushCode(`delete ${item}.$parent;`);
        ctx.pushCode(`delete ${item}.$root;`);
        ctx.pushCode(`delete ${item}.$index;`);
      }
      ctx.popScope();
    }

    if (isHash) {
      ctx.pushCode(`${lhs}[${item}.${key}] = ${item};`);
    } else {
      ctx.pushCode(`${lhs}.push(${item});`);
    }

    ctx.pushCode("}");

    if (typeof this.options.readUntil === "function") {
      const pred = this.options.readUntil;
      const func = ctx.addImport(pred);
      ctx.pushCode(
        `while (!${func}.call(${ctx.generateVariable()}, ${item}, buffer.subarray(offset)));`
      );
    }
  }

  private generateChoiceCase(
    ctx: Context,
    varName: string,
    type: ParserChoice<unknown>
  ) {
    if (typeof type === "string") {
      const varName = ctx.generateVariable(this.varName);
      if (!aliasRegistry.has(type)) {
        const typeName = PRIMITIVE_NAMES[type as PrimitiveTypes];
        const littleEndian = PRIMITIVE_LITTLE_ENDIANS[type as PrimitiveTypes];
        ctx.pushCode(
          `${varName} = dataView.get${typeName}(offset, ${littleEndian});`
        );
        ctx.pushCode(`offset += ${PRIMITIVE_SIZES[type as PrimitiveTypes]}`);
      } else {
        const tempVar = ctx.generateTmpVariable();
        ctx.pushCode(`var ${tempVar} = ${FUNCTION_PREFIX + type}(offset, {`);
        if (ctx.useContextVariables) {
          ctx.pushCode(`$parent: ${varName}.$parent,`);
          ctx.pushCode(`$root: ${varName}.$root,`);
        }
        ctx.pushCode(`});`);
        ctx.pushCode(
          `${varName} = ${tempVar}.result; offset = ${tempVar}.offset;`
        );
        if (type !== this.alias) ctx.addReference(type);
      }
    } else if (type instanceof Parser) {
      ctx.pushPath(varName);
      type.generate(ctx);
      ctx.popPath(varName);
    }
  }

  private generateChoice(this: Parser<T, "choice">, ctx: Context) {
    const tag = ctx.generateOption(this.options.tag!);
    const nestVar = ctx.generateVariable(this.varName);

    if (this.varName) {
      ctx.pushCode(`${nestVar} = {};`);

      if (ctx.useContextVariables) {
        const parentVar = ctx.generateVariable();
        ctx.pushCode(`${nestVar}.$parent = ${parentVar};`);
        ctx.pushCode(`${nestVar}.$root = ${parentVar}.$root;`);
      }
    }
    ctx.pushCode(`switch(${tag}) {`);
    for (const tagString in this.options.choices) {
      const tag = parseInt(tagString, 10);
      const type = this.options.choices[tag];

      ctx.pushCode(`case ${tag}:`);
      this.generateChoiceCase(ctx, this.varName, type);
      ctx.pushCode("break;");
    }
    ctx.pushCode("default:");
    const defaultChoice = (this.options as { defaultChoice: unknown })
      .defaultChoice as Parser<unknown>;
    if (defaultChoice) {
      this.generateChoiceCase(ctx, this.varName, defaultChoice);
    } else {
      ctx.generateError(`"Met undefined tag value " + ${tag} + " at choice"`);
    }
    ctx.pushCode("}");

    if (this.varName && ctx.useContextVariables) {
      ctx.pushCode(`delete ${nestVar}.$parent;`);
      ctx.pushCode(`delete ${nestVar}.$root;`);
    }
  }

  private generateNest(this: Parser<T, "nest">, ctx: Context) {
    const nestVar = ctx.generateVariable(this.varName);

    if (this.options.type instanceof Parser) {
      if (this.varName) {
        ctx.pushCode(`${nestVar} = {};`);

        if (ctx.useContextVariables) {
          const parentVar = ctx.generateVariable();
          ctx.pushCode(`${nestVar}.$parent = ${parentVar};`);
          ctx.pushCode(`${nestVar}.$root = ${parentVar}.$root;`);
        }
      }

      ctx.pushPath(this.varName);
      (this.options.type as Parser<unknown>).generate(ctx);
      ctx.popPath(this.varName);

      if (this.varName && ctx.useContextVariables) {
        if (ctx.useContextVariables) {
          ctx.pushCode(`delete ${nestVar}.$parent;`);
          ctx.pushCode(`delete ${nestVar}.$root;`);
        }
      }
    } else if (aliasRegistry.has(this.options.type!)) {
      const tempVar = ctx.generateTmpVariable();
      ctx.pushCode(
        `var ${tempVar} = ${FUNCTION_PREFIX + this.options.type}(offset, {`
      );
      if (ctx.useContextVariables) {
        const parentVar = ctx.generateVariable();
        ctx.pushCode(`$parent: ${parentVar},`);
        ctx.pushCode(`$root: ${parentVar}.$root,`);
      }
      ctx.pushCode(`});`);
      ctx.pushCode(
        `${nestVar} = ${tempVar}.result; offset = ${tempVar}.offset;`
      );
      if (this.options.type !== this.alias) {
        ctx.addReference(this.options.type!);
      }
    }
  }

  private generateWrapper(this: Parser<T, "wrapper">, ctx: Context) {
    const wrapperVar = ctx.generateVariable(this.varName);
    const wrappedBuf = ctx.generateTmpVariable();
    if (typeof this.options.readUntil === "function") {
      const pred = this.options.readUntil;
      const start = ctx.generateTmpVariable();
      const cur = ctx.generateTmpVariable();

      ctx.pushCode(`var ${start} = offset;`);
      ctx.pushCode(`var ${cur} = 0;`);
      ctx.pushCode(`while (offset < buffer.length) {`);
      ctx.pushCode(`${cur} = dataView.getUint8(offset);`);
      const func = ctx.addImport(pred);
      ctx.pushCode(
        `if (${func}.call(${ctx.generateVariable()}, ${cur}, buffer.subarray(offset))) break;`
      );
      ctx.pushCode(`offset += 1;`);
      ctx.pushCode(`}`);
      ctx.pushCode(`${wrappedBuf} = buffer.subarray(${start}, offset);`);
    } else if (this.options.readUntil === "eof") {
      ctx.pushCode(`${wrappedBuf} = buffer.subarray(offset);`);
    } else {
      const len = ctx.generateOption(this.options.length!);
      ctx.pushCode(`${wrappedBuf} = buffer.subarray(offset, offset + ${len});`);
      ctx.pushCode(`offset += ${len};`);
    }

    if (this.options.clone) {
      ctx.pushCode(`${wrappedBuf} = buffer.constructor.from(${wrappedBuf});`);
    }

    const tempBuf = ctx.generateTmpVariable();
    const tempOff = ctx.generateTmpVariable();
    const tempView = ctx.generateTmpVariable();
    const func = ctx.addImport(this.options.wrapper);
    ctx.pushCode(
      `${wrappedBuf} = ${func}.call(this, ${wrappedBuf}).subarray(0);`
    );
    ctx.pushCode(`var ${tempBuf} = buffer;`);
    ctx.pushCode(`var ${tempOff} = offset;`);
    ctx.pushCode(`var ${tempView} = dataView;`);
    ctx.pushCode(`buffer = ${wrappedBuf};`);
    ctx.pushCode(`offset = 0;`);
    ctx.pushCode(
      `dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);`
    );
    if (this.options.type instanceof Parser) {
      if (this.varName) {
        ctx.pushCode(`${wrapperVar} = {};`);
      }
      ctx.pushPath(this.varName);
      (this.options.type as Parser<unknown>).generate(ctx);
      ctx.popPath(this.varName);
    } else if (aliasRegistry.has(this.options.type!)) {
      const tempVar = ctx.generateTmpVariable();
      ctx.pushCode(
        `var ${tempVar} = ${FUNCTION_PREFIX + this.options.type}(0);`
      );
      ctx.pushCode(`${wrapperVar} = ${tempVar}.result;`);
      if (this.options.type !== this.alias) {
        ctx.addReference(this.options.type!);
      }
    }
    ctx.pushCode(`buffer = ${tempBuf};`);
    ctx.pushCode(`dataView = ${tempView};`);
    ctx.pushCode(`offset = ${tempOff};`);
  }

  private generateFormatter(
    ctx: Context,
    varName: string,
    formatter: Function
  ) {
    if (typeof formatter === "function") {
      const func = ctx.addImport(formatter);
      ctx.pushCode(
        `${varName} = ${func}.call(${ctx.generateVariable()}, ${varName});`
      );
    }
  }

  private generatePointer(this: Parser<T, "pointer">, ctx: Context) {
    const type = this.options.type;
    const offset = ctx.generateOption(this.options.offset!);
    const tempVar = ctx.generateTmpVariable();
    const nestVar = ctx.generateVariable(this.varName);

    // Save current offset
    ctx.pushCode(`var ${tempVar} = offset;`);

    // Move offset
    ctx.pushCode(`offset = ${offset};`);

    if (this.options.type instanceof Parser) {
      ctx.pushCode(`${nestVar} = {};`);

      if (ctx.useContextVariables) {
        const parentVar = ctx.generateVariable();
        ctx.pushCode(`${nestVar}.$parent = ${parentVar};`);
        ctx.pushCode(`${nestVar}.$root = ${parentVar}.$root;`);
      }

      ctx.pushPath(this.varName);
      (this.options.type as Parser<unknown>).generate(ctx);
      ctx.popPath(this.varName);

      if (ctx.useContextVariables) {
        ctx.pushCode(`delete ${nestVar}.$parent;`);
        ctx.pushCode(`delete ${nestVar}.$root;`);
      }
    } else if (aliasRegistry.has(this.options.type!)) {
      const tempVar = ctx.generateTmpVariable();
      ctx.pushCode(
        `var ${tempVar} = ${FUNCTION_PREFIX + this.options.type}(offset, {`
      );
      if (ctx.useContextVariables) {
        const parentVar = ctx.generateVariable();
        ctx.pushCode(`$parent: ${parentVar},`);
        ctx.pushCode(`$root: ${parentVar}.$root,`);
      }
      ctx.pushCode(`});`);
      ctx.pushCode(
        `${nestVar} = ${tempVar}.result; offset = ${tempVar}.offset;`
      );
      if (this.options.type !== this.alias) {
        ctx.addReference(this.options.type!);
      }
    } else if (Object.keys(PRIMITIVE_SIZES).indexOf(this.options.type!) >= 0) {
      const typeName = PRIMITIVE_NAMES[type as PrimitiveTypes];
      const littleEndian = PRIMITIVE_LITTLE_ENDIANS[type as PrimitiveTypes];
      ctx.pushCode(
        `${nestVar} = dataView.get${typeName}(offset, ${littleEndian});`
      );
      ctx.pushCode(`offset += ${PRIMITIVE_SIZES[type as PrimitiveTypes]};`);
    }

    // Restore offset
    ctx.pushCode(`offset = ${tempVar};`);
  }

  private generateSaveOffset(this: Parser<T, "saveOffset">, ctx: Context) {
    const varName = ctx.generateVariable(this.varName);
    ctx.pushCode(`${varName} = offset`);
  }
}
