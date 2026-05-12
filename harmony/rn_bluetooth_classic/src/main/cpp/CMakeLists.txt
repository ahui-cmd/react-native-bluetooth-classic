cmake_minimum_required(VERSION 3.13)
set(CMAKE_VERBOSE_MAKEFILE on)

set(rn_bluetooth_classic_generated_dir "${CMAKE_CURRENT_SOURCE_DIR}/generated")
file(GLOB_RECURSE rn_bluetooth_classic_generated_SRC "${rn_bluetooth_classic_generated_dir}/**/*.cpp")
file(GLOB rn_bluetooth_classic_SRC CONFIGURE_DEPENDS *.cpp)
add_library(rn_bluetooth_classic SHARED ${rn_bluetooth_classic_SRC} ${rn_bluetooth_classic_generated_SRC})
target_include_directories(rn_bluetooth_classic PUBLIC ${CMAKE_CURRENT_SOURCE_DIR} ${rn_bluetooth_classic_generated_dir})
target_link_libraries(rn_bluetooth_classic PUBLIC rnoh)