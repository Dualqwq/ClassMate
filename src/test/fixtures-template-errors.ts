// 模板实例化回溯链测试夹具(P5,设计依据 cpp-template-error-parsing-research-20260825.md)。
// 全部逐字取自本机 g++ 16.1.0 (MinGW-w64) 实测输出 tmp-template-error-research/out_*.txt,
// 只做行级截取;Clang/MSVC 形态本机无编译器,不在此收录(测试内按官方句式构造并标注 untested)。

// out_c1_default.txt 全文:sort(_List_iterator<int>) 链 + include 栈共存 + 缩进候选列表。
export const C1_DEFAULT = `In file included from D:/mingw64/include/c++/16.1.0/algorithm:63,
                 from c1_sort_list.cpp:2:
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h: In instantiation of 'void std::__sort(_RandomAccessIterator, _RandomAccessIterator, _Compare) [with _RandomAccessIterator = _List_iterator<int>; _Compare = less<void>]':
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:4817:18:   required from 'void std::sort(_RAIter, _RAIter) [with _RAIter = _List_iterator<int>]'
 4817 |       std::__sort(__first, __last, __gnu_cxx::__ops::less());
      |       ~~~~~~~~~~~^~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
c1_sort_list.cpp:7:14:   required from here
    7 |     std::sort(lst.begin(), lst.end());
      |     ~~~~~~~~~^~~~~~~~~~~~~~~~~~~~~~~~
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1914:50: error: no match for 'operator-' (operand types are 'std::_List_iterator<int>' and 'std::_List_iterator<int>')
 1914 |                                 std::__lg(__last - __first) * 2,
      |                                           ~~~~~~~^~~~~~~~~
  • there are 2 candidates
In file included from D:/mingw64/include/c++/16.1.0/bits/stl_algobase.h:66,
                 from D:/mingw64/include/c++/16.1.0/algorithm:62:
    • candidate 1: 'template<class _IteratorL, class _IteratorR> constexpr decltype ((__y.base() - __x.base())) std::operator-(const reverse_iterator<_Iterator>&, const reverse_iterator<_IteratorR>&)'
      D:/mingw64/include/c++/16.1.0/bits/stl_iterator.h:620:5:
        620 |     operator-(const reverse_iterator<_IteratorL>& __x,
            |     ^~~~~~~~
      • template argument deduction/substitution failed:
        •   'std::_List_iterator<int>' is not derived from 'const std::reverse_iterator<_Iterator>'
          D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1914:50:
           1914 |                                 std::__lg(__last - __first) * 2,
                |                                           ~~~~~~~^~~~~~~~~
    • candidate 2: 'template<class _IteratorL, class _IteratorR> constexpr decltype ((__x.base() - __y.base())) std::operator-(const move_iterator<_IteratorL>&, const move_iterator<_IteratorR>&)'
      D:/mingw64/include/c++/16.1.0/bits/stl_iterator.h:1798:5:
       1798 |     operator-(const move_iterator<_IteratorL>& __x,
            |     ^~~~~~~~
      • template argument deduction/substitution failed:
        •   'std::_List_iterator<int>' is not derived from 'const std::move_iterator<_IteratorL>'
          D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1914:50:
           1914 |                                 std::__lg(__last - __first) * 2,
                |                                           ~~~~~~~^~~~~~~~~`;

// out_c1_oldlook.txt 全文:-fno-diagnostics-show-nesting 旧观感,链帧行形态相同,
// 候选/note 行顶格(新观感里它们是缩进的)。
export const C1_OLDLOOK = `In file included from D:/mingw64/include/c++/16.1.0/algorithm:63,
                 from c1_sort_list.cpp:2:
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h: In instantiation of 'void std::__sort(_RandomAccessIterator, _RandomAccessIterator, _Compare) [with _RandomAccessIterator = _List_iterator<int>; _Compare = less<void>]':
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:4817:18:   required from 'void std::sort(_RAIter, _RAIter) [with _RAIter = _List_iterator<int>]'
 4817 |       std::__sort(__first, __last, __gnu_cxx::__ops::less());
      |       ~~~~~~~~~~~^~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
c1_sort_list.cpp:7:14:   required from here
    7 |     std::sort(lst.begin(), lst.end());
      |     ~~~~~~~~~^~~~~~~~~~~~~~~~~~~~~~~~
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1914:50: error: no match for 'operator-' (operand types are 'std::_List_iterator<int>' and 'std::_List_iterator<int>')
 1914 |                                 std::__lg(__last - __first) * 2,
      |                                           ~~~~~~~^~~~~~~~~
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1914:50: note: there are 2 candidates
In file included from D:/mingw64/include/c++/16.1.0/bits/stl_algobase.h:66,
                 from D:/mingw64/include/c++/16.1.0/algorithm:62:
D:/mingw64/include/c++/16.1.0/bits/stl_iterator.h:620:5: note: candidate 1: 'template<class _IteratorL, class _IteratorR> constexpr decltype ((__y.base() - __x.base())) std::operator-(const reverse_iterator<_Iterator>&, const reverse_iterator<_IteratorR>&)'
  620 |     operator-(const reverse_iterator<_IteratorL>& __x,
      |     ^~~~~~~~
D:/mingw64/include/c++/16.1.0/bits/stl_iterator.h:620:5: note: template argument deduction/substitution failed:
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1914:50: note:   'std::_List_iterator<int>' is not derived from 'const std::reverse_iterator<_Iterator>'
 1914 |                                 std::__lg(__last - __first) * 2,
      |                                           ~~~~~~~^~~~~~~~~
D:/mingw64/include/c++/16.1.0/bits/stl_iterator.h:1798:5: note: candidate 2: 'template<class _IteratorL, class _IteratorR> constexpr decltype ((__x.base() - __y.base())) std::operator-(const move_iterator<_IteratorL>&, const move_iterator<_IteratorR>&)'
 1798 |     operator-(const move_iterator<_IteratorL>& __x,
      |     ^~~~~~~~
D:/mingw64/include/c++/16.1.0/bits/stl_iterator.h:1798:5: note: template argument deduction/substitution failed:
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1914:50: note:   'std::_List_iterator<int>' is not derived from 'const std::move_iterator<_IteratorL>'
 1914 |                                 std::__lg(__last - __first) * 2,
      |                                           ~~~~~~~^~~~~~~~~`;

// out_c2.txt 全文:transform + map 迭代器 + 非 const 引用 lambda;链 2 帧,
// 候选区里有缩进的 c2_transform_map.cpp:13:21/:20 行,不得混入链帧。
export const C2_TRANSFORM_MAP = `In file included from D:/mingw64/include/c++/16.1.0/algorithm:63,
                 from c2_transform_map.cpp:3:
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h: In instantiation of '_OIter std::transform(_IIter, _IIter, _OIter, _UnaryOperation) [with _IIter = _Rb_tree_iterator<pair<const __cxx11::basic_string<char>, int> >; _OIter = back_insert_iterator<vector<pair<__cxx11::basic_string<char>, int> > >; _UnaryOperation = main()::<lambda(pair<__cxx11::basic_string<char>, int>&)>]':
c2_transform_map.cpp:12:19:   required from here
   12 |     std::transform(m.begin(), m.end(), std::back_inserter(v),
      |     ~~~~~~~~~~~~~~^~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
   13 |                    [](std::pair<std::string, int>& p) { return p; });
      |                    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:4240:31: error: no match for call to '(main()::<lambda(std::pair<std::__cxx11::basic_string<char>, int>&)>) (std::pair<const std::__cxx11::basic_string<char>, int>&)'
 4240 |         *__result = __unary_op(*__first);
      |                     ~~~~~~~~~~^~~~~~~~~~
  • there are 2 candidates
    c2_transform_map.cpp:13:21:
       13 |                    [](std::pair<std::string, int>& p) { return p; });
          |                     ^
    • candidate 1: 'std::pair<std::__cxx11::basic_string<char>, int> (*)(std::pair<std::__cxx11::basic_string<char>, int>&)' (conversion)
      D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:4240:31:
       4240 |         *__result = __unary_op(*__first);
            |                     ~~~~~~~~~~^~~~~~~~~~
      • conversion of argument 2 would be ill-formed:
      • error: cannot bind non-const lvalue reference of type 'std::pair<std::__cxx11::basic_string<char>, int>&' to an rvalue of type 'std::pair<std::__cxx11::basic_string<char>, int>'
In file included from D:/mingw64/include/c++/16.1.0/bits/stl_algobase.h:63,
                 from D:/mingw64/include/c++/16.1.0/algorithm:62:
      •   after user-defined conversion: 'constexpr std::pair<_T1, _T2>::pair(const std::pair<_U1, _U2>&) [with _U1 = const std::__cxx11::basic_string<char>; _U2 = int; typename std::enable_if<(std::_PCC<((! std::is_same<_T1, _U1>::value) || (! std::is_same<_T2, _U2>::value)), _T1, _T2>::_ConstructiblePair<_U1, _U2>() && std::_PCC<((! std::is_same<_T1, _U1>::value) || (! std::is_same<_T2, _U2>::value)), _T1, _T2>::_ImplicitlyConvertiblePair<_U1, _U2>()), bool>::type <anonymous> = true; _T1 = std::__cxx11::basic_string<char>; _T2 = int]'
        D:/mingw64/include/c++/16.1.0/bits/stl_pair.h:802:19:
          802 |         constexpr pair(const pair<_U1, _U2>& __p)
              |                   ^~~~
    • candidate 2: 'main()::<lambda(std::pair<std::__cxx11::basic_string<char>, int>&)>' (near match)
      c2_transform_map.cpp:13:20:
         13 |                    [](std::pair<std::string, int>& p) { return p; });
            |                    ^
      • conversion of argument 1 would be ill-formed:
      • error: cannot bind non-const lvalue reference of type 'std::pair<std::__cxx11::basic_string<char>, int>&' to an rvalue of type 'std::pair<std::__cxx11::basic_string<char>, int>'
      •   after user-defined conversion: 'constexpr std::pair<_T1, _T2>::pair(const std::pair<_U1, _U2>&) [with _U1 = const std::__cxx11::basic_string<char>; _U2 = int; typename std::enable_if<(std::_PCC<((! std::is_same<_T1, _U1>::value) || (! std::is_same<_T2, _U2>::value)), _T1, _T2>::_ConstructiblePair<_U1, _U2>() && std::_PCC<((! std::is_same<_T1, _U1>::value) || (! std::is_same<_T2, _U2>::value)), _T1, _T2>::_ImplicitlyConvertiblePair<_U1, _U2>()), bool>::type <anonymous> = true; _T1 = std::__cxx11::basic_string<char>; _T2 = int]'
        D:/mingw64/include/c++/16.1.0/bits/stl_pair.h:802:19:
          802 |         constexpr pair(const pair<_U1, _U2>& __p)
              |                   ^~~~`;

// out_c3.txt 行 1-18:sort(vector<Point>) 缺 operator< 的 5 帧链(源码摘录行夹在帧间)。
export const C3_SORT_PATH = `In file included from D:/mingw64/include/c++/16.1.0/algorithm:63,
                 from c3_set_missing_lt.cpp:4:
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h: In instantiation of 'void std::__insertion_sort(_RandomAccessIterator, _RandomAccessIterator, _Compare) [with _RandomAccessIterator = __gnu_cxx::__normal_iterator<Point*, vector<Point> >; _Compare = less<void>]':
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1821:25:   required from 'void std::__final_insertion_sort(_RandomAccessIterator, _RandomAccessIterator, _Compare) [with _RandomAccessIterator = __gnu_cxx::__normal_iterator<Point*, vector<Point> >; _Compare = less<void>]'
 1821 |           std::__insertion_sort(__first, __first + __threshold, __comp);
      |           ~~~~~~~~~~~~~~~~~~~~~^~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1916:31:   required from 'void std::__sort(_RandomAccessIterator, _RandomAccessIterator, _Compare) [with _RandomAccessIterator = __gnu_cxx::__normal_iterator<Point*, vector<Point> >; _Compare = less<void>]'
 1916 |           std::__final_insertion_sort(__first, __last, __comp);
      |           ~~~~~~~~~~~~~~~~~~~~~~~~~~~^~~~~~~~~~~~~~~~~~~~~~~~~
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:4817:18:   required from 'void std::sort(_RAIter, _RAIter) [with _RAIter = __gnu_cxx::__normal_iterator<Point*, vector<Point> >]'
 4817 |       std::__sort(__first, __last, __gnu_cxx::__ops::less());
      |       ~~~~~~~~~~~^~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
c3_set_missing_lt.cpp:17:14:   required from here
   17 |     std::sort(v.begin(), v.end());
      |     ~~~~~~~~~^~~~~~~~~~~~~~~~~~~~
D:/mingw64/include/c++/16.1.0/bits/stl_algo.h:1781:21: error: no match for call to '(std::less<void>) (Point&, Point&)'
 1781 |           if (__comp(*__i, *__first))
      |               ~~~~~~^~~~~~~~~~~~~~~~`;

// out_c3.txt 行 132-150:同一编译单元里第二个错误的 set 插入路径,6 帧链
// (含超长模板签名的 required 帧),叶子是 operator< 形态。
export const C3_SET_PATH = `D:/mingw64/include/c++/16.1.0/bits/stl_function.h: In instantiation of 'constexpr bool std::less<_Tp>::operator()(const _Tp&, const _Tp&) const [with _Tp = Point]':
D:/mingw64/include/c++/16.1.0/bits/stl_tree.h:1406:33:   required from 'bool std::_Rb_tree<_Key, _Val, _KeyOfValue, _Compare, _Alloc>::_M_key_compare(const _Key1&, const _Key2&) const [with _Key1 = Point; _Key2 = Point; _Key = Point; _Val = Point; _KeyOfValue = std::_Identity<Point>; _Compare = std::less<Point>; _Alloc = std::allocator<Point>]'
 1406 |           return _M_impl._M_key_compare(__k1, __k2);
      |                  ~~~~~~~~~~~~~~~~~~~~~~^~~~~~~~~~~~
D:/mingw64/include/c++/16.1.0/bits/stl_tree.h:2811:27:   required from 'std::pair<typename std::__rb_tree::_Node_traits<_Val, typename __gnu_cxx::__alloc_traits<typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Val>::other>::pointer>::_Base_ptr, typename std::__rb_tree::_Node_traits<_Val, typename __gnu_cxx::__alloc_traits<typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Val>::other>::pointer>::_Base_ptr> std::_Rb_tree<_Key, _Val, _KeyOfValue, _Compare, _Alloc>::_M_get_insert_unique_pos(const key_type&) [with _Key = Point; _Val = Point; _KeyOfValue = std::_Identity<Point>; _Compare = std::less<Point>; _Alloc = std::allocator<Point>; typename std::__rb_tree::_Node_traits<_Val, typename __gnu_cxx::__alloc_traits<typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Val>::other>::pointer>::_Base_ptr = std::__rb_tree::_Node_traits<Point, Point*>::_Node_base*; typename __gnu_cxx::__alloc_traits<typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Val>::other>::pointer = Point*; typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Val>::other = std::allocator<Point>; class __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Val> = __gnu_cxx::__alloc_traits<std::allocator<Point>, Point>::rebind<Point>; typename _Alloc::value_type = Point; typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Val>::other::value_type = Point; key_type = Point]'
 2811 |           __comp = _M_key_compare(__k, _S_key(__x));
      |                    ~~~~~~~~~~~~~~^~~~~~~~~~~~~~~~~~
D:/mingw64/include/c++/16.1.0/bits/stl_tree.h:2913:4:   required from 'std::pair<typename std::__rb_tree::_Node_traits<_Val, typename __gnu_cxx::__alloc_traits<typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Val>::other>::pointer>::_Iterator, bool> std::_Rb_tree<_Key, _Val, _KeyOfValue, _Compare, _Alloc>::_M_insert_unique(_Arg&&) [with _Arg = const Point&; _Key = Point; _Val = Point; _KeyOfValue = std::_Identity<Point>; _Compare = std::less<Point>; _Alloc = std::allocator<Point>; typename std::__rb_tree::_Node_traits<_Val, typename __gnu_cxx::__alloc_traits<typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Val>::other>::pointer>::_Iterator = std::__rb_tree::_Node_traits<Point, Point*>::_Iterator; typename __gnu_cxx::__alloc_traits<typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Val>::other>::pointer = Point*; typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Val>::other = std::allocator<Point>; class __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Val> = __gnu_cxx::__alloc_traits<std::allocator<Point>, Point>::rebind<Point>; typename _Alloc::value_type = Point; typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Val>::other::value_type = Point]'
 2913 |         = _M_get_insert_unique_pos(_KeyOfValue()(__v));
      |           ^~~~~~~~~~~~~~~~~~~~~~~~
D:/mingw64/include/c++/16.1.0/bits/stl_set.h:537:25:   required from 'std::pair<typename std::_Rb_tree<_Key, _Key, std::_Identity<_Tp>, _Compare, typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Key>::other>::const_iterator, bool> std::set<_Key, _Compare, _Alloc>::insert(const value_type&) [with _Key = Point; _Compare = std::less<Point>; _Alloc = std::allocator<Point>; typename std::_Rb_tree<_Key, _Key, std::_Identity<_Tp>, _Compare, typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Key>::other>::const_iterator = std::_Rb_tree<Point, Point, std::_Identity<Point>, std::less<Point>, std::allocator<Point> >::const_iterator; typename __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Key>::other = std::allocator<Point>; class __gnu_cxx::__alloc_traits<_Alloc>::rebind<_Key> = __gnu_cxx::__alloc_traits<std::allocator<Point>, Point>::rebind<Point>; typename _Alloc::value_type = Point; value_type = Point]'
  537 |           _M_t._M_insert_unique(__x);
      |           ~~~~~~~~~~~~~~~~~~~~~^~~~~
c3_set_missing_lt.cpp:14:13:   required from here
   14 |     s.insert(p);
      |     ~~~~~~~~^~~
D:/mingw64/include/c++/16.1.0/bits/stl_function.h:408:20: error: no match for 'operator<' (operand types are 'const Point' and 'const Point')
  408 |       { return __x < __y; }
      |                ~~~~^~~~~`;

// out_c4.txt 行 1-6:叶子报在学生行,无链(ostream 候选在学生行就地展开)。
export const C4_OSTREAM = `c4_ostream_custom.cpp: In function 'int main()':
c4_ostream_custom.cpp:12:9: error: no match for 'operator<<' (operand types are 'std::ostringstream' {aka 'std::__cxx11::basic_ostringstream<char>'} and 'Student')
   12 |     oss << s;
      |     ~~~ ^~ ~
      |     |      |
      |     |      Student`;

// out_c5.txt 全文:对照组——依赖名缺 typename,本来就报在学生行,无链。
export const C5_TYPENAME = `c5_missing_typename.cpp: In function 'void f()':
c5_missing_typename.cpp:6:5: error: need 'typename' before 'T::iterator' because 'T' is a dependent scope [-Wtemplate-body]
    6 |     T::iterator it;
      |     ^`;

// out_c6.txt 全文:vector<bool> 代理引用,报在学生行,无链。
export const C6_VECTOR_BOOL = `c6_vectorbool_binding.cpp: In function 'int main()':
c6_vectorbool_binding.cpp:6:20: error: cannot bind non-const lvalue reference of type 'std::_Bit_reference&' to an rvalue of type 'std::_Bit_iterator::reference'
    6 |     for (auto& b : flags) {
      |                    ^~~~~`;
