dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
        maven(url = "https://jcenter.bintray.com")
        google()
        maven(url = "https://jitpack.io")
    }
}
rootProject.name = "Open Note Scanner"
include(":app")
